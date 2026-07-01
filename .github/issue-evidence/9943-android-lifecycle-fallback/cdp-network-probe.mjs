// CDP experiment: do window online/offline events fire in the Android WebView on
// real connectivity changes, and does @capacitor/network actually report them?
import { execSync } from "node:child_process";

const PORT = process.env.CDP_PORT || "9333";
const SERIAL = process.env.ANDROID_SERIAL || "emulator-5554";
const PKG = "ai.elizaos.app";
const adb = (a) =>
  execSync(`adb -s ${SERIAL} ${a}`, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 15000);
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        clearTimeout(t);
        ws.removeEventListener("message", onMsg);
        m.error
          ? reject(new Error(JSON.stringify(m.error)))
          : resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}
const evalx = async (ws, e) =>
  (
    await cdp(ws, "Runtime.evaluate", {
      expression: e,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result?.value;
function reforward() {
  const pid = adb(`shell pidof ${PKG}`).split(/\s+/)[0];
  const sock =
    adb("shell cat /proc/net/unix").match(
      new RegExp(`webview_devtools_remote_${pid}`),
    )?.[0] ||
    adb("shell cat /proc/net/unix").match(/webview_devtools_remote_\d+/)?.[0];
  if (!sock) throw new Error("no socket");
  try {
    adb(`forward --remove tcp:${PORT}`);
  } catch {}
  adb(`forward tcp:${PORT} localabstract:${sock}`);
}
async function connect() {
  for (let i = 0; i < 12; i++) {
    try {
      reforward();
      const list = JSON.parse(
        execSync(`curl -s http://127.0.0.1:${PORT}/json`, { encoding: "utf8" }),
      );
      const page =
        list.find((t) => t.type === "page" && t.url?.includes("localhost")) ||
        list.find((t) => t.webSocketDebuggerUrl);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res);
        ws.addEventListener("error", rej);
      });
      await cdp(ws, "Runtime.enable");
      return ws;
    } catch (e) {
      await sleep(1000);
    }
  }
  throw new Error("connect failed");
}

(async () => {
  const ws = await connect();
  const init = await evalx(
    ws,
    `(async () => {
    window.__net = [];
    window.addEventListener("online", () => window.__net.push("online"));
    window.addEventListener("offline", () => window.__net.push("offline"));
    let getStatus = null, addErr = null;
    const Net = window.Capacitor?.Plugins?.Network;
    try { getStatus = Net ? JSON.stringify(await Net.getStatus()) : "no-plugin"; } catch (e) { getStatus = "ERR:" + (e.message||e); }
    window.__capnet = [];
    try { if (Net?.addListener) await Net.addListener("networkStatusChange", (s) => window.__capnet.push(s.connected)); }
    catch (e) { addErr = String(e.message||e); }
    return { onLine: navigator.onLine, hasNetworkPlugin: !!Net, capacitorGetStatus: getStatus, capacitorAddListenerError: addErr };
  })()`,
  );
  console.log("init:", JSON.stringify(init));

  console.log("disabling connectivity (wifi + data off)...");
  adb("shell svc wifi disable");
  adb("shell svc data disable");
  await sleep(4000);
  console.log("re-enabling connectivity...");
  adb("shell svc wifi enable");
  adb("shell svc data enable");
  await sleep(5000);

  let net, capnet;
  try {
    net = await evalx(ws, "JSON.stringify(window.__net||[])");
    capnet = await evalx(ws, "JSON.stringify(window.__capnet||[])");
  } catch {
    const w2 = await connect();
    net = await evalx(w2, "JSON.stringify(window.__net||[])");
    capnet = await evalx(w2, "JSON.stringify(window.__capnet||[])");
  }
  console.log("window online/offline events:", net);
  console.log("Capacitor networkStatusChange (connected) events:", capnet);
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
