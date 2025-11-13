/**********************
 * TIỆN ÍCH CHUNG
 **********************/
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


let stopRequested = false;

// — CÓ THỂ TINH CHỈNH TỪ UI NẾU MUỐN —
let GAP_BETWEEN_SEND_MS = 3000;   // nghỉ giữa mỗi lần GỬI prompt (ms)
let POLL_INTERVAL_MS = 1200;      // nghỉ giữa mỗi lần POLL (ms)

/** Jittered sleep để tránh nhịp đồng bộ (±tỷ lệ) */
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

navigateBtn?.addEventListener("click", () => chrome.tabs.create({ url: "https://labs.google/fx/" }));
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
  logMessage(`📚 Tổng số prompt: ${lines.length}. Bắt đầu từ prompt #${startIndex0 + 1}.`, "system");
}
function markRunning(promptIdx1) {
  const item = promptStatus[promptIdx1 - 1];
  if (item && item.state === "queued") {
    item.state = "running";
    runningCount += 1;
    logMessage(`▶️ Đang chạy prompt #${promptIdx1}`, "info");
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
    if(failedCount>3){
      inputSlotMax.value =1;
    }
    logMessage(`⚠️ Prompt #${promptIdx1} không tạo được.`, "warn");
    updateLiveStatus();
  }
}
function updateLiveStatus() {
  const total = promptStatus.length;
  liveStatus.textContent = `Đang chạy: ${runningCount} | Đã xong: ${doneCount}/${total} | Lỗi: ${failedCount}`;
  // Tiến độ theo kết quả thực tế:
  // const totalDone = doneCount + failedCount;
  // const pct = Math.round((totalDone / total) * 100);
  // progressBar.value = Number.isFinite(pct) ? pct : 0;
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

/**********************
 * GỬI PROMPT (nguyên thuỷ – dùng trong safeSendOnePrompt)
 **********************/
function processPromptOnPage(prompt) {
  const findInput = () =>
    document.getElementById("PINHOLE_TEXT_AREA_ELEMENT_ID") ||
    document.querySelector('textarea[aria-label*="prompt" i], textarea[placeholder*="prompt" i], textarea');

  const input = findInput();
  if (!input) return { ok: false, reason: "Không tìm thấy ô nhập prompt" };

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
               || function (v) { this.value = v; };
  setter.call(input, prompt);
  input.dispatchEvent(new Event("input", { bubbles: true }));

  function findGenerateButton() {
    let btn = Array.from(document.querySelectorAll("button"))
      .find(b => (b.innerText || "").trim() === "Tạo");
    if (btn) return btn;

    const icon = Array.from(document.querySelectorAll("button i, button span"))
      .find(el => (el.textContent || "").trim().includes("arrow_forward"));
    if (icon) return icon.closest("button");

    try {
      const node = document.evaluate(
        '//*[@id="__next"]/div[2]/div/div/div[2]/div/div[1]/div[2]/div/div[2]/div[2]/button[2]',
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
      if (node) return node;
    } catch {}

    return null;
  }

  const btn = findGenerateButton();
  if (!btn) return { ok: false, reason: "Không tìm thấy nút Generate" };
  if (btn.disabled) return { ok: false, reason: "Nút Generate đang bị khóa" };

  ["pointerdown", "mousedown", "mouseup", "click"].forEach(type => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window });
    btn.dispatchEvent(ev);
  });

  return { ok: true };
}

/**********************
 * ĐỌC TRẠNG THÁI SLOT
 **********************/
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

/**********************
 * ÁNH XẠ PROMPT
 **********************/
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

/**********************
 * RATE LIMITER + SAFE SEND (backoff & retry)
 **********************/
const RateLimiter = (() => {
  let nextAvailableAt = 0;
  let backoffMs = 5000;        // 5s khởi điểm
  const maxBackoffMs = 60000;  // 60s
  const minBackoffMs = 3000;   // 3s

  return {
    async wait() {
      const now = Date.now();
      if (now < nextAvailableAt) {
        await sleep(nextAvailableAt - now);
      }
    },
    on429() {
      backoffMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, backoffMs * 2));
      nextAvailableAt = Date.now() + backoffMs;
    },
    onSuccess() {
      backoffMs = Math.max(minBackoffMs, Math.floor(backoffMs * 0.7));
    },
    cooldown(ms) {
      nextAvailableAt = Date.now() + ms;
    }
  };
})();

/** Gửi prompt an toàn, có retry/backoff khi nghi 429 */
async function safeSendOnePrompt(prompt, idx1, attempt = 1, maxAttempts = 3) {
  await RateLimiter.wait();
  const res = await injectScript(processPromptOnPage, [prompt]);

  if (res?.ok) {
    markRunning(idx1);
    logMessage(`🚀 Đã gửi prompt #${idx1} (lần ${attempt})`, "success");
    RateLimiter.onSuccess();
    return true;
  }

  const reason = (res?.reason || "").toLowerCase();
  const maybe429 =
    reason.includes("bị khóa") ||
    reason.includes("too many") ||
    reason.includes("quá nhiều") ||
    reason.includes("limit");

  if (maybe429 && attempt < maxAttempts) {
    logMessage(`⏳ Nghi rate limit (429). Backoff rồi thử lại prompt #${idx1}…`, "warn");
    RateLimiter.on429();
    await jitteredSleep(4000, 0.5);
    return safeSendOnePrompt(prompt, idx1, attempt + 1, maxAttempts);
  }

  logMessage(`⚠️ Lỗi gửi prompt #${idx1}: ${res?.reason || "Không rõ"}`, "warn");
  return false;
}

/**********************
 * CORE: REFILL + VÒNG LẶP CHÍNH (KHÔNG repeatEach)
 **********************/
async function runWithRefill(prompts, startIdx0 = 0) {
  initPromptStatus(prompts, startIdx0);

  const list = prompts.slice(startIdx0);
  let queuedPtr = 0;        // prompt chưa gửi
  let activeRenders = 0;    // slot đang bận

  async function topUpToCapacity() {
    while (!stopRequested && activeRenders < inputSlotMax.value && queuedPtr < list.length) {

      const text = list[queuedPtr];
      const idx1 = startIdx0 + queuedPtr + 1;
      const ok = await safeSendOnePrompt(text, idx1);
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
    const checkCount = Math.max(1, Math.min(inputSlotMax.value, activeRenders));
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

    if (!finishedSlots && !(queuedPtr < list.length && activeRenders < inputSlotMax.value)) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  if (stopRequested) {
    liveStatus.textContent = "Đã dừng.";
    logMessage("⏹️ Dừng theo yêu cầu.", "warn");
    return false;
  } else {
    liveStatus.textContent = "Đã render xong tất cả prompt.";
    logMessage(`🎉 Render xong. 📊 Thành công ${doneCount}, Thất bại ${failedCount}.`, "success");
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
    waitItemMs: 3000,       // ⬆ tăng timeout hợp lý (bản cũ 150ms gần như luôn timeout)
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
        const WAIT_ITEM_MS = userOpts.waitItemMs || 3000; // tổng timeout tìm item
        const AFTER_CLICK_DELAY = userOpts.afterClickDelay || 200;
        const BETWEEN_ITEMS_DELAY = userOpts.betweenItemsDelay || 150;

        function isVisible(el) {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const vh = window.innerHeight || document.documentElement.clientHeight;
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh;
        }

        function getScrollContainer() {
          // Tìm container có scroll; fallback document.scrollingElement
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
          // Cuộn dần để thấy node có data-index = index, trong giới hạn thời gian
          const start = Date.now();
          for (;;) {
            const node = document.querySelector(`[data-index="${index}"]`);
            if (node) return node;

            // Cuộn xuống từng bước
            scroller.scrollBy({ top: SCROLL_STEP, behavior: "auto" });

            // Nếu đã cuối danh sách -> coi như hết
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
            // Lần theo vài cấp cha để khoanh vùng menu
            let scope = videoEl.closest('[class]') || indexNode;
            for (let i = 0; i < 4 && scope && scope !== indexNode; i++) {
              scope = scope.parentElement;
            }
            scope = scope || indexNode;

            const candidates = Array.from(scope.querySelectorAll('button[aria-haspopup="menu"], [role="button"]'));
            // Ưu tiên nút có chữ "download"
            return (
              candidates.find((btn) => /download/i.test(btn.textContent || "")) ||
              candidates.find((btn) => (btn.getAttribute("aria-label") || "").toLowerCase().includes("download")) ||
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
            const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="menu"] [role="menuitem"]'));
            if (items.length) return items;
            if (Date.now() > start + WAIT_MENU_MS) return null;
            await sleep(80);
          }
        }

        function pickMenuItem(menuItems, preferredList) {
          const textOf = (el) => (el.textContent || "").trim().toLowerCase();

          // Thử khớp độ phân giải (chấp nhận "720", "720p", "1080", "1080p", …)
          for (const res of preferredList) {
            const needle = String(res).toLowerCase();
            const found = menuItems.find((mi) => {
              const t = textOf(mi);
              return t.includes(needle) || t.includes(`${needle}p`);
            });
            if (found) return found;
          }

          // fallback: item chứa "download"
          const anyDownload = menuItems.find((mi) => textOf(mi).includes("download"));
          return anyDownload || menuItems[0] || null;
        }

        // ====== Luồng chính ======
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
            // vẫn cuộn tiếp để lộ item sau
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
              // fallback theo index/biến thể để tránh double-click cùng phần tử
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
      // 🔁 Truyền đúng tham số đã chuẩn hoá vào context trang
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
    // Nếu muốn tự động tải tuần tự sau khi render xong:
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


/**********************
 * LISTENER
 **********************/
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'log') {
    logMessage(request.msg, request.level || 'info');
  }
  if (request.type === 'download_finished') {
    if (typeof resetState === 'function') {
      resetState(typeof i18n === 'function' ? i18n('reset_completed') : 'Hoàn tất');
    } else {
      logMessage('🏁 Tải tuần tự: hoàn tất.', 'success');
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

/**********************
 * IMPORT PROMPT TỪ FILE .TXT
 **********************/
const uploadBtn = $("#uploadPromptButton");
const fileInput = $("#fileInput");

uploadBtn?.addEventListener("click", () => fileInput?.click());
fileInput?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  txtPrompts.value = text;
  const count = text.split("\n").map(s=>s.trim()).filter(Boolean).length;
  logMessage(`📄 Đã nạp ${count} dòng prompt từ file.`, "info");
});
