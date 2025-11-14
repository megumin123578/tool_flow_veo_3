
const $ = (sel) => document.querySelector(sel);
const logBox = $("#logDisplay");
// const progressBar = $("#progressBar");
const liveStatus = $("#liveStatus");
const btnStart = $("#mainActionButton");
const btnStop = $("#stopButton");
const btnDownload = $("#downloadButton");
const txtPrompts = $("#prompts");
const inputStartFrom = $("#startFromInput");
const inputSlotMax = $("#SlotMaxFromInput");

const navigateBtn = $("#navigateToFlowButton");
const wrongPageOverlay = $("#wrong-page-interface");
const mainInterface = $("#main-interface");
const autoDownloadToggle = $("#autoDownloadToggle");
let autoSequentialEnabled = false;

// Upload prompt & ảnh
const uploadBtn = $("#uploadPromptButton");
const fileInput = $("#fileInput");

const imageUploadBtn = $("#uploadImageButton");
const imageInput = $("#imageInput");
const imageUploadStatus = $("#imageUploadStatus");

// Danh sách ảnh đã chọn (File[])
let imageFiles = [];

let stopRequested = false;

let GAP_BETWEEN_SEND_MS = 3000;   // nghỉ giữa mỗi lần GỬI prompt (ms)
let POLL_INTERVAL_MS = 1200;      // nghỉ giữa mỗi lần POLL (ms)

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitteredSleep(baseMs, jitterRatio = 0.3) {
  const jitter = baseMs * jitterRatio;
  const ms = baseMs + (Math.random() * 2 - 1) * jitter; // ±jitter
  return sleep(Math.max(0, Math.round(ms)));
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function logMessage(message, level = "info") {
  if (!logBox) return;
  const line = document.createElement("div");
  line.className = `log-entry log-${level}`;
  const ts = document.createElement("span");
  ts.className = "log-timestamp";
  ts.textContent = `[${timestamp()}]`;
  const msg = document.createElement("span");
  msg.className = "log-message";
  msg.textContent = message;
  line.appendChild(ts);
  line.appendChild(msg);
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}
function setUIRunning(running) {
  btnStart.disabled = running;
  btnStop.disabled = !running;
  btnDownload.disabled = running;
}

/**********************
 * KIỂM TRA TRANG HỢP LỆ
 **********************/
const FLOW_HOST_PREFIX = "labs.google/fx";

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkRightPageAndToggleUI() {
  const tab = await getActiveTab();
  const onFlow = !!(tab?.url && tab.url.includes(FLOW_HOST_PREFIX));
  wrongPageOverlay.style.display = onFlow ? "none" : "flex";
  mainInterface.style.display = onFlow ? "flex" : "none";
}

navigateBtn?.addEventListener("click", () =>
  chrome.tabs.create({ url: "https://labs.google/fx/" })
);
chrome.tabs.onActivated.addListener(checkRightPageAndToggleUI);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) checkRightPageAndToggleUI();
});
checkRightPageAndToggleUI();

/**********************
 * TRẠNG THÁI PROMPT
 **********************/
const normalize = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 200);
let allPrompts = [];
let promptStatus = [];
let runningCount = 0;
let doneCount = 0;
let failedCount = 0;

function initPromptStatus(lines, startIndex0) {
  allPrompts = lines;
  promptStatus = lines.map((t, i) => ({
    index: i + 1, text: t, norm: normalize(t), state: "queued"
  }));
  runningCount = 0;
  doneCount = 0;
  failedCount = 0;
  updateLiveStatus();
  logMessage(
    `📚 Tổng số prompt: ${lines.length}. Bắt đầu từ prompt #${startIndex0 + 1}.`,
    "system"
  );
}
function markRunning(promptIdx1) {
  const item = promptStatus[promptIdx1 - 1];
  if (item && item.state === "queued") {
    item.state = "running";
    runningCount += 1;
    updateLiveStatus();
  }
}
function markDone(promptIdx1) {
  const item = promptStatus[promptIdx1 - 1];
  if (item && item.state !== "done" && item.state !== "failed") {
    item.state = "done";
    //runningCount = Math.max(0, runningCount - 1);
    doneCount += 1;
    logMessage(`✅ Hoàn thành prompt #${promptIdx1}`, "success");
    updateLiveStatus();
  }
}
function markFailed(promptIdx1) {
  const item = promptStatus[promptIdx1 - 1];
  if (item && item.state !== "done" && item.state !== "failed") {
    item.state = "failed";
    //runningCount = Math.max(0, runningCount - 1);
    failedCount += 1;
    if (failedCount > 3) {
      inputSlotMax.value = 1;
    }
    logMessage(`⚠️ Prompt #${promptIdx1} không tạo được.`, "warn");
    updateLiveStatus();
  }
}
function updateLiveStatus() {
  const total = promptStatus.length;
  liveStatus.textContent = `Đang chạy: ${runningCount} | Đã xong: ${doneCount}/${total} | Lỗi: ${failedCount}`;
}

/**********************
 * INJECT HÀM VÀO TRANG
 **********************/
async function injectScript(fn, args = []) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("Không tìm thấy tab hiện tại.");
  if (!tab.url || !tab.url.includes(FLOW_HOST_PREFIX)) {
    throw new Error("Vui lòng mở Google Flow (https://labs.google/fx/).");
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fn,
    args,
    world: "MAIN",
  });
  return result;
}

async function processPromptOnPage(prompt, imagePayload) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // === 1. Tìm & set text prompt ===
  const findInput = () =>
    document.getElementById("PINHOLE_TEXT_AREA_ELEMENT_ID") ||
    document.querySelector(
      'textarea[aria-label*="prompt" i], textarea[placeholder*="prompt" i], textarea'
    );

  const input = findInput();
  if (!input) return { ok: false, reason: "Không tìm thấy ô nhập prompt" };

  const setter =
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set ||
    function (v) { this.value = v; };
  setter.call(input, prompt);
  input.dispatchEvent(new Event("input", { bubbles: true }));

  // === 2. GẮN ẢNH: xoá frame cũ → click nút add → chọn file → crop & save ===
if (imagePayload) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 2.0: Xoá tất cả frame / overlay có nút close
  try {
    const snapshot = document.evaluate(
      "//button[.//div[@data-type='button-overlay'] and .//i[normalize-space()='close']]",
      document,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );

    for (let i = 0; i < snapshot.snapshotLength; i++) {
      const btn = snapshot.snapshotItem(i);
      btn.click();
      await wait(250);
    }
  } catch (e) {
    console.warn("Không xoá được frame ảnh cũ:", e);
  }

  try {
    const findAddButton = () => {
      let btn = null;

      // Thử XPATH chuẩn
      try {
        btn = document.evaluate(
          "(//button[.//div[@data-type='button-overlay'] and .//i[normalize-space()='add']])[1]",
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
      } catch (e) {}

      // Fallback text / icon
      if (!btn) {
        btn = Array.from(document.querySelectorAll("button")).find((b) => {
          const txt = (b.textContent || "").toLowerCase();
          if (txt.includes("thêm khung") || txt.includes("add frame")) return true;
          const icon = b.querySelector("i, span");
          return icon && (icon.textContent || "").trim() === "add";
        });
      }

      return btn;
    };

    const addBtn = findAddButton();
    if (!addBtn) {
      console.warn("Không tìm thấy nút add image.");
    } else {
      const beforeInputs = document.querySelectorAll('input[type="file"]').length;

      addBtn.click();
      await wait(500); // chờ panel/selector mở ra

      const existingAssetBtn = document.evaluate(
        "(" +
          "//span[contains(normalize-space(.),'Một thành phần nội dung nghe nhìn')]" +
          "/ancestor::button[1]" +
        ")[1]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      if (existingAssetBtn) {
        existingAssetBtn.click();
        await wait(800);
      } else {

        let fileInput = null;
        const maxWaitMs = 8000;
        const start = Date.now();

        while (Date.now() - start < maxWaitMs) {
          const all = document.querySelectorAll('input[type="file"]');
          if (all.length > beforeInputs) {
            fileInput = all[all.length - 1];
            break;
          }
          if (!fileInput && all.length > 0) {
            // fallback: nếu đã tồn tại sẵn từ trước
            fileInput = all[all.length - 1];
          }
          if (fileInput) break;
          await wait(200);
        }

        if (!fileInput) {
          console.warn("Không tìm thấy input[file] sau khi bấm nút add (hết thời gian chờ).");
        } else {
          const bytes = new Uint8Array(imagePayload.bytes || []);
          const blob = new Blob([bytes], { type: imagePayload.type || "image/png" });
          const file = new File(
            [blob],
            imagePayload.name || "image.png",
            { type: imagePayload.type || "image/png" }
          );

          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;

          const changeEv = new Event("change", { bubbles: true });
          fileInput.dispatchEvent(changeEv);

          const maxWaitCropMs = 10000;
          const startCrop = Date.now();
          let cropButton = null;

          while (Date.now() - startCrop < maxWaitCropMs) {
            cropButton = document.evaluate(
              "//button[.//i[normalize-space()='crop'] or contains(normalize-space(),'Crop and Save')]",
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue;

            if (cropButton) break;
            await wait(300);
          }

          if (cropButton) {
            cropButton.click();
            await wait(800); // cho modal đóng hẳn
          } else {
            console.warn("Không tìm thấy nút Crop and Save (hết thời gian chờ).");
          }
        }
      }
    }
  } catch (e) {
    console.error("Không thể auto click & attach ảnh:", e);
  }
}

  // === 3. TÌM VÀ CLICK NÚT GENERATE ===
  async function waitForGenerateButton(timeout = 3000) {
    const start = Date.now();

    function getCandidates() {
      const btns = Array.from(document.querySelectorAll("button"));

      // Theo text "Tạo"
      let can = btns.filter(b =>
        (b.innerText || "").trim() === "Tạo"
      );

      // Theo icon → arrow_forward
      if (!can.length) {
        const icons = Array.from(document.querySelectorAll("button i, button span"))
          .filter(el => (el.textContent || "").trim().includes("arrow_forward"))
          .map(el => el.closest("button"))
          .filter(Boolean);
        can = icons;
      }

      // Lọc nút fake
      can = can.filter(b =>
        !b.hasAttribute("disabled") &&
        b.getAttribute("aria-disabled") !== "true" &&
        b.offsetWidth > 0 &&
        b.offsetHeight > 0 &&
        window.getComputedStyle(b).opacity !== "0" &&
        window.getComputedStyle(b).pointerEvents !== "none"
      );

      return can[0] || null;
    }

    let btn = getCandidates();
    while (!btn) {
      if (Date.now() - start >= timeout) return null;
      await new Promise(r => setTimeout(r, 100));
      btn = getCandidates();
    }

    return btn;
  }



  const btn = await waitForGenerateButton();

  if (!btn)
    return { ok: false, reason: "Không tìm thấy nút Generate (timeout)" };

  // Nếu sẵn sàng: click
  ["pointerdown", "mousedown", "mouseup", "click"].forEach(type =>
    btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  );

  return { ok: true };
}


function getSlotsStatus(indices) {
  const hasAddToScene = (root) => {
    const btns = root.querySelectorAll("button");
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (/thêm vào cảnh/i.test(t)) return true;
    }
    return false;
  };
  const hasPlayOrVideo = (root) => {
    if (root.querySelector("video")) return true;
    const icons = root.querySelectorAll("i, svg, span");
    for (const ic of icons) {
      const t = (ic.textContent || "").trim();
      if (/play_arrow/i.test(t)) return true;
    }
    return false;
  };
  const readPercent = (root) => {
    const els = root.querySelectorAll("div, span, p");
    let best = null;
    for (const el of els) {
      const tx = (el.textContent || "").trim();
      if (/^\d{1,3}%$/.test(tx)) {
        const n = parseInt(tx, 10);
        if (!Number.isNaN(n)) best = Math.max(best ?? 0, n);
      }
    }
    return best;
  };
  const hasFailure = (root) => {
    const els = root.querySelectorAll("div, span, p, h1, h2, h3");
    for (const el of els) {
      const tx = (el.textContent || "").trim();
      if (/không tạo được/i.test(tx)) return true;
    }
    return false;
  };
  const readPromptText = (root) => {
    const btns = Array.from(root.querySelectorAll("button"));
    let longest = "";
    for (const b of btns) {
      const t = (b.innerText || b.textContent || "").trim();
      if (t && t.length > longest.length) longest = t;
    }
    return longest || null;
  };

  const result = {};
  for (const idx of indices) {
    const root =
      document.querySelector(`[data-index="${idx}"][data-item-index]`) ||
      document.querySelector(`[data-index="${idx}"]`);
    if (!root) {
      result[idx] = { ready: false, percent: null, failed: false, promptText: null };
      continue;
    }
    const percent = readPercent(root);
    const failed = hasFailure(root);
    const ready =
      failed ||
      hasAddToScene(root) ||
      hasPlayOrVideo(root) ||
      (typeof percent === "number" && percent >= 100);
    const promptText = readPromptText(root);
    result[idx] = { ready, percent: percent ?? null, failed, promptText };
  }
  return result;
}


function buildNormMap() {
  const map = new Map();
  for (const p of promptStatus) {
    const list = map.get(p.norm) || [];
    list.push(p.index);
    map.set(p.norm, list);
  }
  return map;
}
function findPromptIndexByText(promptText) {
  if (!promptText) return null;
  const norm = normalize(promptText);
  const map = buildNormMap();
  const arr = map.get(norm);
  if (arr && arr.length) {
    const running = arr.find(i => promptStatus[i - 1].state === "running");
    if (running) return running;
    const queued = arr.find(i => promptStatus[i - 1].state === "queued");
    if (queued) return queued;
    const notDone = arr.find(i => !["done", "failed"].includes(promptStatus[i - 1].state));
    if (notDone) return notDone;
    return arr[0];
  }
  for (const p of promptStatus) {
    if (norm && p.norm.startsWith(norm.slice(0, 60))) return p.index;
  }
  return null;
}



async function safeSendOnePrompt(prompt, idx1, imageFile = null) {
  let imagePayload = null;

  if (imageFile) {
    try {
      const buf = await imageFile.arrayBuffer();
      imagePayload = {
        name: imageFile.name,
        type: imageFile.type,
        bytes: Array.from(new Uint8Array(buf)),
      };
    } catch (e) {
      logMessage(`⚠️ Không đọc được file ảnh cho prompt #${idx1}: ${e.message}`, "warn");
    }
  }

  const res = await injectScript(processPromptOnPage, [prompt, imagePayload]);

  if (res?.ok) {
    markRunning(idx1);
    logMessage(`🚀 Đã gửi prompt #${idx1}`, "success");
    return true;
  }

  logMessage(`⚠️ Lỗi gửi prompt #${idx1}: ${res?.reason || "Không rõ"}`, "warn");
  return false;
}

async function runWithRefill(prompts, startIdx0 = 0) {
  initPromptStatus(prompts, startIdx0);

  const list = prompts.slice(startIdx0);
  let queuedPtr = 0;        // prompt chưa gửi
  let activeRenders = 0;    // slot đang bận

  const getMaxSlots = () => {
    const n = parseInt(inputSlotMax.value || "1", 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };

  async function topUpToCapacity() {
    while (!stopRequested && activeRenders < getMaxSlots() && queuedPtr < list.length) {
      const text = list[queuedPtr];
      const idx1 = startIdx0 + queuedPtr + 1;

      let imgFile = null;
        if (imageFiles.length > 0) {
          // quay vòng theo số prompt
          imgFile = imageFiles[(idx1 - 1) % imageFiles.length];
        }

      const ok = await safeSendOnePrompt(text, idx1, imgFile);
      if (ok) {
        queuedPtr += 1;
        activeRenders += 1;
      } else {
        await jitteredSleep(2000, 0.5);
        break;
      }
      await jitteredSleep(GAP_BETWEEN_SEND_MS, 0.35);
    }
  }

  await topUpToCapacity();
  while (!stopRequested && (queuedPtr < list.length || activeRenders > 0)) {
    const maxSlots = getMaxSlots();
    const checkCount = Math.max(1, Math.min(maxSlots, activeRenders));
    const indices = Array.from({ length: checkCount }, (_, i) => i + 1);

    let statuses = {};
    try {
      statuses = await injectScript(getSlotsStatus, [indices]);
    } catch (e) {
      logMessage(`❌ Lỗi đọc trạng thái slot: ${e.message}`, "error");
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    let finishedSlots = 0;
    for (const i of indices) {
      const st = statuses[i];
      if (!st || !st.ready) continue;

      const guessIdx1 = findPromptIndexByText(st.promptText);
      if (guessIdx1 != null) {
        if (st.failed) {
          markFailed(guessIdx1);
        } else {
          markDone(guessIdx1);
        }
      } else {
        if (st.failed) logMessage(`⚠️ Slot báo lỗi nhưng không xác định được prompt.`, "warn");
      }
      finishedSlots += 1;
    }

    if (finishedSlots > 0) {
      activeRenders = Math.max(0, activeRenders - finishedSlots);
    }

    if (!stopRequested && queuedPtr < list.length) {
      await topUpToCapacity();
    }

    if (!finishedSlots && !(queuedPtr < list.length && activeRenders < maxSlots)) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (stopRequested) {
    liveStatus.textContent = "Đã dừng.";
    logMessage("⏹️ Dừng theo yêu cầu.", "warn");
    return false;
  } else {
    liveStatus.textContent = "Đã render xong tất cả prompt.";
    logMessage(`Render xong. Thành công ${doneCount}, Thất bại ${failedCount}.`, "success");
    // progressBar.value = 100;
    return true;
  }
}

/**********************
 * SAU KHI RENDER XONG: TẢI TUẦN TỰ (v2)
 **********************/
async function runSequentialDownload_Legacy(opts = {}) {
  liveStatus.textContent = "Đang tải tuần tự (v2)…";
  const normalizeStartIndex = (v) => {
    if (typeof v === "string" && v.trim() === "") return 1;
    const n = +v; // ép kiểu mềm
    return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  };
  const mergedOpts = {
    preferredResolutions: ["720", "1080"], // mặc định hợp lý hơn
    maxIndex: 9999,
    scrollStep: 800,
    waitMenuMs: 300,
    waitItemMs: 3000,
    afterClickDelay: 200,
    betweenItemsDelay: 150,
    ...opts,
    startIndex: normalizeStartIndex(opts.startIndex),
  };

  logMessage(
    "⬇️ Bắt đầu tải tuần tự bắt đầu từ index = " + mergedOpts.startIndex,
    "system"
  );

  try {
    const resul = await injectScript(
      async function (userOpts = {}) {
        // ===== Helpers trong context trang =====
        const LOG = (m) => console.log("[FMC/SEQ-DL]", m);
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

        const PREFERRED_RES = userOpts.preferredResolutions || ["720"];
        const START_INDEX = userOpts.startIndex || 1;
        const MAX_INDEX_GUESS = userOpts.maxIndex || 9999;

        const SCROLL_STEP = userOpts.scrollStep || 800;
        const WAIT_MENU_MS = userOpts.waitMenuMs || 300;
        const WAIT_ITEM_MS = userOpts.waitItemMs || 3000;
        const AFTER_CLICK_DELAY = userOpts.afterClickDelay || 200;
        const BETWEEN_ITEMS_DELAY = userOpts.betweenItemsDelay || 150;

        function isVisible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const vh = window.innerHeight || document.documentElement.clientHeight;
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh;
        }

        function getScrollContainer() {
          const firstIndexed = document.querySelector('[data-index]');
          let n = firstIndexed && firstIndexed.parentElement;
          while (n) {
            const style = getComputedStyle(n);
            if (/(auto|scroll)/i.test(style.overflowY)) return n;
            n = n.parentElement;
          }
          return document.scrollingElement || document.documentElement || document.body;
        }

        async function ensureIndexLoaded(scroller, index) {
          const start = Date.now();
          for (;;) {
            const node = document.querySelector(`[data-index="${index}"]`);
            if (node) return node;

            scroller.scrollBy({ top: SCROLL_STEP, behavior: "auto" });

            const atBottom = Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 2;
            if (atBottom) return null;

            if (Date.now() > start + WAIT_ITEM_MS) return null;
            await sleep(120);
          }
        }

        async function jumpToStartIndex(scroller, startIndex) {
          const maybe = document.querySelector(`[data-index="${startIndex}"]`) ||
            (await ensureIndexLoaded(scroller, startIndex));
          if (!maybe) return false;
          maybe.scrollIntoView({ block: "center", behavior: "auto" });
          await sleep(200);
          return isVisible(maybe);
        }

        function findVariantsWithin(indexNode) {
          const videos = Array.from(indexNode.querySelectorAll('video[src], video'));
          function findDownloadButtonFor(videoEl) {
            let scope = videoEl.closest('[class]') || indexNode;
            for (let i = 0; i < 4 && scope && scope !== indexNode; i++) {
              scope = scope.parentElement;
            }
            scope = scope || indexNode;

            const candidates = Array.from(scope.querySelectorAll('button[aria-haspopup="menu"], [role="button"]'));
            return (
              candidates.find((btn) => /download/i.test(btn.textContent || "")) ||
              candidates.find((btn) =>
                (btn.getAttribute("aria-label") || "").toLowerCase().includes("download")
              ) ||
              null
            );
          }
          return videos
            .map((v) => ({ video: v, btn: findDownloadButtonFor(v) }))
            .filter((x) => x.btn);
        }

        async function waitForMenuOpen() {
          const start = Date.now();
          for (;;) {
            const items = Array.from(
              document.querySelectorAll('[role="menuitem"], [role="menu"] [role="menuitem"]')
            );
            if (items.length) return items;
            if (Date.now() > start + WAIT_MENU_MS) return null;
            await sleep(80);
          }
        }

        function pickMenuItem(menuItems, preferredList) {
          const textOf = (el) => (el.textContent || "").trim().toLowerCase();

          for (const res of preferredList) {
            const needle = String(res).toLowerCase();
            const found = menuItems.find((mi) => {
              const t = textOf(mi);
              return t.includes(needle) || t.includes(`${needle}p`);
            });
            if (found) return found;
          }

          const anyDownload = menuItems.find((mi) => textOf(mi).includes("download"));
          return anyDownload || menuItems[0] || null;
        }

        const visitedVideoSrc = new Set();
        const scroller = getScrollContainer();

        const okJump = await jumpToStartIndex(scroller, START_INDEX);
        if (!okJump) {
          LOG(`Không tìm thấy index=${START_INDEX}. Dừng.`);
          return { ok: 0, fail: 0, indicesDone: 0, reason: "start-index-not-found" };
        }

        let ok = 0, fail = 0, indicesDone = 0;

        for (let index = START_INDEX; index <= MAX_INDEX_GUESS; index++) {
          const node = await ensureIndexLoaded(scroller, index);
          if (!node) {
            LOG(`Hết danh sách ở index=${index}.`);
            break;
          }

          const variants = findVariantsWithin(node);
          if (!variants.length) {
            LOG(`Index #${index}: không có biến thể.`);
            indicesDone++;
            scroller.scrollBy({ top: SCROLL_STEP, behavior: "auto" });
            await sleep(120);
            continue;
          }

          LOG(`Index #${index}: ${variants.length} biến thể.`);

          for (let vi = 0; vi < variants.length; vi++) {
            const { video, btn } = variants[vi];
            const src =
              video.getAttribute("src") ||
              video.currentSrc ||
              `index${index}-var${vi + 1}`;

            if (visitedVideoSrc.has(src)) {
              LOG(`- Biến thể #${vi + 1}: đã xử lý trước → bỏ qua.`);
              continue;
            }

            video.scrollIntoView({ block: "center", behavior: "auto" });
            await sleep(120);

            try {
              btn.click();
              const menuItems = await waitForMenuOpen();
              if (!menuItems) throw new Error("menu-timeout");

              const choice = pickMenuItem(menuItems, PREFERRED_RES);
              if (!choice) throw new Error("no-menuitem");

              choice.click();
              visitedVideoSrc.add(src);
              ok++;
              LOG(`- Biến thể #${vi + 1}: tải (${(choice.textContent || "").trim()}).`);
              await sleep(AFTER_CLICK_DELAY);
            } catch (e) {
              fail++;
              LOG(`- Biến thể #${vi + 1}: lỗi → ${e && e.message ? e.message : e}`);
            }

            await sleep(BETWEEN_ITEMS_DELAY);
          }

          indicesDone++;
          scroller.scrollBy({ top: SCROLL_STEP, behavior: "auto" });
          await sleep(120);
        }

        LOG(`✅ Hoàn tất: OK=${ok}, FAIL=${fail}, Từ index=${START_INDEX}`);
        return { ok, fail, indicesDone, startIndex: START_INDEX };
      },
      [mergedOpts]
    );

    logMessage(`✅ Hoàn tất: OK=${resul.ok}, FAIL=${resul.fail}`, "success");
    liveStatus.textContent = "Tải tuần tự Hoàn Tất";
  } catch (e) {
    logMessage(`❌ Lỗi: ${e.message}`, "error");
    liveStatus.textContent = "Lỗi khi tải.";
  }
}

/**********************
 * KHỞI CHẠY & SỰ KIỆN NÚT
 **********************/
async function startAutomation() {
  stopRequested = false;
  setUIRunning(true);
  // progressBar.value = 0;
  liveStatus.textContent = "Chuẩn bị...";

  const lines = (txtPrompts.value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (lines.length === 0) {
    logMessage("Bạn chưa nhập prompt nào.", "warn");
    liveStatus.textContent = "Thiếu prompt";
    setUIRunning(false);
    return;
  }

  const startFrom = Math.max(1, parseInt(inputStartFrom.value || "1", 10));
  const startIndex0 = Math.min(lines.length - 1, startFrom - 1);

  initPromptStatus(lines, startIndex0);
  updateLiveStatus();

  logMessage(
    `Chế độ: tối đa ${inputSlotMax.value} slot song song. Nghỉ ~${GAP_BETWEEN_SEND_MS}ms giữa lần gửi. ` +
    `Auto tải sau khi render: ${autoSequentialEnabled ? "BẬT" : "TẮT"}. ` +
    `Bắt đầu từ prompt #${startIndex0 + 1}.`,
    "system"
  );

  try {
    const finished = await runWithRefill(lines, startIndex0);
    if (finished && !stopRequested && autoSequentialEnabled) {
      logMessage("⬇️ Tự động tải tuần tự sau khi render xong (đang bắt đầu)…", "system");
      await runSequentialDownload_Legacy({ startIndex: 1, preferredResolutions: ["720"] });
    } else {
      logMessage("ℹ️ Đã tắt tự động tải sau khi render. Bạn có thể bấm nút 'Tải' bất kỳ lúc nào.", "info");
    }
  } catch (e) {
    logMessage(`❌ Lỗi: ${e.message}`, "error");
  } finally {
    setUIRunning(false);
  }
}

function stopAutomation() {
  stopRequested = true;
  inputStartFrom.value = runningCount + 1;
  liveStatus.textContent = "Đang dừng...";
  logMessage("⏹️ Sẽ dừng ở bước kế tiếp.", "warn");
}

btnStart?.addEventListener("click", startAutomation);
btnStop?.addEventListener("click", stopAutomation);
btnDownload?.addEventListener("click", async () => {
  await runSequentialDownload_Legacy({ startIndex: inputStartFrom.value, preferredResolutions: ["720"] });
});


chrome.runtime.onMessage.addListener((request) => {
  if (request.type === "log") {
    logMessage(request.msg, request.level || "info");
  }
  if (request.type === "download_finished") {
    if (typeof resetState === "function") {
      resetState(typeof i18n === "function" ? i18n("reset_completed") : "Hoàn tất");
    } else {
      logMessage("🏁 Tải tuần tự: hoàn tất.", "success");
    }
  }
});

// Load persisted setting
chrome.storage?.sync?.get({ autoSequentialEnabled: false }, (cfg) => {
  autoSequentialEnabled = !!cfg.autoSequentialEnabled;
  if (autoDownloadToggle) autoDownloadToggle.checked = autoSequentialEnabled;
});

autoDownloadToggle?.addEventListener("change", (e) => {
  autoSequentialEnabled = !!e.target.checked;
  chrome.storage?.sync?.set({ autoSequentialEnabled });
  logMessage(
    autoSequentialEnabled
      ? "🟢 Đã bật: tự tải tuần tự sau khi render xong."
      : "⚪️ Đã tắt: không tự tải sau khi render.",
    "info"
  );
});


uploadBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  txtPrompts.value = text;
  const count = text.split("\n").map((s) => s.trim()).filter(Boolean).length;
  logMessage(`Đã nạp ${count} dòng prompt từ file.`, "info");
});


imageUploadBtn?.addEventListener("click", () => imageInput?.click(), { once: true });
imageInput?.addEventListener("change", onImageChange, { once: true });

function onImageChange(e) {
    imageFiles = Array.from(e.target.files || []);
    imageUploadStatus.textContent = `Đã chọn ${imageFiles.length} ảnh.`;
}
