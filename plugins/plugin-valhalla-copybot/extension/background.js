importScripts("vendor/nacl.min.js", "trust.js", "connect-core.js");

function sessionFrom(message, address, nonce) {
  const exp = /Expiration Time: (.+)/.exec(message);
  return {
    address,
    nonce: nonce || "",
    expiresAt: exp ? exp[1] : "",
  };
}

async function saveSignIn(msg) {
  const proof = {
    message: msg.message,
    signature: Uint8Array.from(atob(String(msg.signature || "")), (char) => char.charCodeAt(0)),
    publicKey: msg.address,
  };
  if (!ValhallaConnect.verifySiws(self.nacl, proof)) return { ok: false };
  await chrome.storage.local.set({
    watchAddress: msg.address,
    siwsSession: sessionFrom(msg.message, msg.address, msg.nonce),
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "siws") return;
  saveSignIn(msg).then(sendResponse);
  return true;
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const origin = sender.origin || "";
  if (origin !== "https://valhalla-app.xyz" && origin !== "https://www.valhalla-app.xyz") {
    sendResponse({ ok: false });
    return;
  }
  if (!msg || msg.type !== "siws") return;
  saveSignIn(msg).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ installed: true });
});
