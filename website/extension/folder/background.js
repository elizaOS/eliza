chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed: true });
});
