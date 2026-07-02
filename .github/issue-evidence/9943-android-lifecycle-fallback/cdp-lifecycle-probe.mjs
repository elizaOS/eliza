// CDP experiment: does real Android backgrounding fire eliza:app-pause /
// eliza:app-resume in the app's WebView? Drives the running ai.elizaos.app
// WebView over the forwarded devtools socket.
import { execSync } from "node:child_process";

const PORT = process.env.CDP_PORT || "9333";
const SERIAL = process.env.ANDROID_SERIAL || "emulator-5554";
const PKG = "ai.elizaos.app";
const adb = (args) =>
  execSync(`adb -s ${SERIAL} ${args}`, { encoding: "utf8" }).trim();

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
        if (m.error) reject(new Error(`${method}: ${JSON.stringify(m.error)}`));
        else resolve(m.result);
      }
    };
    ws.addEventListener("message", onMsg);
  });
}
const evaluate = async (ws, expression) =>
  (
    await cdp(ws, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result?.value;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reforward() {
  // Re-derive the app's WebView devtools socket and re-point the forward at it
  // (the socket name / forward can change across a background→foreground cycle).
  const pid = adb(`shell pidof ${PKG}`).split(/\s+/)[0];
  const unix = adb("shell cat /proc/net/unix");
  const sock =
    unix.match(new RegExp(`webview_devtools_remote_${pid}`))?.[0] ||
    unix.match(/webview_devtools_remote_\d+/)?.[0];
  if (!sock) throw new Error("no webview devtools socket");
  try {
    adb(`forward --remove tcp:${PORT}`);
  } catch {}
  adb(`forward tcp:${PORT} localabstract:${sock}`);
  return sock;
}

async function connect() {
  // Retry: the devtools HTTP endpoint can take a moment after a foreground.
  let lastErr;
  for (let i = 0; i < 12; i += 1) {
    try {
      reforward();
      const list = JSON.parse(
        execSync(`curl -s http://127.0.0.1:${PORT}/json`, { encoding: "utf8" }),
      );
      const page =
        list.find((t) => t.type === "page" && t.url?.includes("localhost")) ||
        list.find((t) => t.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) throw new Error("no CDP page target");
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res);
        ws.addEventListener("error", rej);
      });
      await cdp(ws, "Runtime.enable");
      return ws;
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  throw lastErr;
}

(async () => {
  let ws = await connect();
  // Install observers for the real lifecycle events the app dispatches on document.
  const installed = await evaluate(
    ws,
    `(async () => {
    window.__lc = [];
    document.addEventListener("eliza:app-pause", () => window.__lc.push("pause"));
    document.addEventListener("eliza:app-resume", () => window.__lc.push("resume"));
    // ALSO add a DIRECT Capacitor App appStateChange listener, to see whether
    // Capacitor itself fires (isolating "Capacitor not firing" from "app handler
    // not dispatching the document event").
    window.__cap = [];
    const App = window.Capacitor?.Plugins?.App;
    let directListener = false;
    window.__caperr = null;
    if (App?.addListener) {
      try { await App.addListener("appStateChange", (s) => window.__cap.push(s.isActive)); directListener = true; }
      catch (e) { window.__caperr = String(e && e.message || e); }
    }
    // Also raw visibility, as a cross-check the OS backgrounded the WebView.
    window.__vis = [];
    document.addEventListener("visibilitychange", () => window.__vis.push(document.visibilityState));
    return {
      observersInstalled: true,
      hasCapacitor: typeof window.Capacitor !== "undefined",
      capPlatform: window.Capacitor?.getPlatform?.(),
      hasAppPlugin: !!App, directListener,
      href: location.href,
    };
  })()`,
  );
  console.log("observer install:", JSON.stringify(installed));

  console.log("backgrounding the app (KEYCODE_HOME)...");
  adb("shell input keyevent KEYCODE_HOME");
  await sleep(2500);

  console.log(
    "foregrounding the app (reorder existing task to front, no reload)...",
  );
  // Force-stop the concurrent actor's interfering showcase, then resume the
  // EXISTING task to front (REORDER_TO_FRONT) so the WebView is not recreated.
  try {
    adb("shell am force-stop ai.eliza.plugins.swabble.test");
  } catch {}
  adb(`shell am start -n ${PKG}/.MainActivity -f 0x20020000`);
  await sleep(3500);

  // The socket/forward changes across a foreground cycle — reconnect robustly.
  let lc;
  try {
    lc = await evaluate(ws, "JSON.stringify(window.__lc || [])");
  } catch {
    console.log("(reconnecting CDP after foreground)");
    try {
      ws.close();
    } catch {}
    ws = await connect();
    lc = await evaluate(ws, "JSON.stringify(window.__lc || [])");
  }
  const lcType = await evaluate(ws, "typeof window.__lc");
  const cap = await evaluate(ws, "JSON.stringify(window.__cap || [])");
  const caperr = await evaluate(ws, "String(window.__caperr)");
  console.log("App.addListener error:", caperr);
  const vis = await evaluate(ws, "JSON.stringify(window.__vis || [])");
  console.log(
    `window.__lc type after foreground: ${lcType} (undefined => WebView was RELOADED, lost observers)`,
  );
  console.log(`direct Capacitor appStateChange (isActive) events: ${cap}`);
  console.log(`raw document.visibilitychange states: ${vis}`);
  console.log("app eliza:app-pause/resume events recorded:", lc);
  const arr = JSON.parse(lc || "[]");
  const sawPause = arr.includes("pause");
  const sawResume = arr.includes("resume");
  console.log(`RESULT: pause=${sawPause} resume=${sawResume}`);
  console.log(
    sawPause && sawResume
      ? "✅ real backgrounding drives the lifecycle chain"
      : "⚠️ events did not both fire (see array)",
  );
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
