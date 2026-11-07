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

// Sovereign Bridge & Edge Swarm Connection (Port 3001)
let sovereignSocket = null;
const BRIDGE_URL = "ws://127.0.0.1:3001";

function connectSovereignBridge() {
  try {
    sovereignSocket = new WebSocket(BRIDGE_URL);

    sovereignSocket.onopen = () => {
      chrome.storage.local.get(["userWallet", "perpxKey"], (res) => {
        if (sovereignSocket && sovereignSocket.readyState === WebSocket.OPEN) {
          sovereignSocket.send(JSON.stringify({
            action: "NODE_HANDSHAKE",
            wallet: res.userWallet || "ANONYMOUS_OPERATOR",
            hasPerpxApi: !!res.perpxKey,
          }));
        }
      });
    };

    sovereignSocket.onmessage = async (event) => {
      try {
        const task = JSON.parse(event.data);
        if (task.type === "PASSIVE_SCRAPE_TASK" && chrome.tabs && chrome.scripting) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab && tab.id) {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => document.body.innerText.substring(0, 3000),
            }, (results) => {
              if (results && results[0] && sovereignSocket && sovereignSocket.readyState === WebSocket.OPEN) {
                sovereignSocket.send(JSON.stringify({
                  action: "TASK_COMPLETE",
                  taskId: task.id,
                  content: results[0].result,
                }));
              }
            });
          }
        }
      } catch (err) {
        // Safe swarm error handling
      }
    };

    sovereignSocket.onclose = () => {
      setTimeout(connectSovereignBridge, 5000);
    };

    sovereignSocket.onerror = () => {
      if (sovereignSocket) sovereignSocket.close();
    };
  } catch (err) {
    setTimeout(connectSovereignBridge, 5000);
  }
}

connectSovereignBridge();
