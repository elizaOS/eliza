// #10197 stability cell: on-device JS-heap behavior across repeated
// background/foreground cycles of the real app (a leak/soak the existing PRs
// don't cover). Drives ai.elizaos.app's WebView over CDP-via-adb, samples
// performance.memory.usedJSHeapSize per cycle, and reports the trajectory.
import { execSync } from "node:child_process";

const PORT = process.env.CDP_PORT || "9333";
const SERIAL = process.env.ANDROID_SERIAL || "emulator-5554";
const PKG = "ai.elizaos.app";
const CYCLES = Number(process.env.CYCLES || 12);
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
  if (!sock) throw new Error("no devtools socket");
  try {
    adb(`forward --remove tcp:${PORT}`);
  } catch {}
  adb(`forward tcp:${PORT} localabstract:${sock}`);
}
async function connect() {
  for (let i = 0; i < 15; i++) {
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
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("connect failed");
}
const heapMB = async (ws) => {
  const v = await evalx(
    ws,
    "(performance.memory && performance.memory.usedJSHeapSize) || 0",
  );
  return v ? +(v / 1048576).toFixed(2) : 0;
};

(async () => {
  let ws = await connect();
  const supported = await evalx(
    ws,
    "typeof performance.memory !== 'undefined'",
  );
  console.log(`performance.memory available: ${supported}`);
  // settle + a couple GC-ish idle waits, then baseline
  await sleep(1500);
  const samples = [await heapMB(ws)];
  console.log(`baseline heap: ${samples[0]} MB`);
  for (let i = 1; i <= CYCLES; i++) {
    adb("shell input keyevent KEYCODE_HOME"); // background → visibilitychange hidden
    await sleep(1200);
    try {
      adb("shell am force-stop ai.eliza.plugins.swabble.test");
    } catch {}
    adb(`shell am start -n ${PKG}/.MainActivity -f 0x20020000`); // foreground (no reload)
    await sleep(1600);
    let h;
    try {
      h = await heapMB(ws);
    } catch {
      ws = await connect();
      h = await heapMB(ws);
    }
    samples.push(h);
    console.log(`cycle ${String(i).padStart(2)}: heap ${h} MB`);
  }
  const base = samples[0],
    last = samples[samples.length - 1];
  const peak = Math.max(...samples);
  const growth = base > 0 ? +(last - base).toFixed(2) : 0;
  console.log(`\n=== ${CYCLES} background/foreground cycles ===`);
  console.log(
    `baseline=${base}MB  final=${last}MB  peak=${peak}MB  net growth=${growth}MB (${base > 0 ? (last / base).toFixed(3) : "n/a"}×)`,
  );
  console.log(
    growth > base * 0.5
      ? "⚠️ heap grew >50% across cycles — possible retained-on-background leak (no APP_PAUSE prune firing)"
      : "heap stayed bounded across background/foreground cycles",
  );
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
