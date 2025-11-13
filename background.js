const FLOW_URL = "https://labs.google/fx/";

chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.startsWith(FLOW_URL)) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  } else {
    chrome.tabs.create({ url: FLOW_URL });
  }
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.type === "openDownloadsSettings") {
    chrome.tabs.create({ url: "chrome://settings/downloads" });
  }
});