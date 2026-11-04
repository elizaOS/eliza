/**
 * Desk entry point. `bun start`, `bun dashboard`, `start.sh`, and `start.bat`
 * all run this file.
 *
 * Bun reads the `.env` file in this folder on its own, so a Brain key in `.env`
 * works with no extra step. That makes the documented first run the only step.
 *
 * This file starts the local desk and nothing else. It does not arm live
 * trading, hold a key, or send a transaction. Arming live trading stays a
 * deliberate tap in the app, and the wallet stays locked until you unlock it.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { startDashboard } from "./dashboard.ts";
import { AgentEngine } from "./engine.ts";

function openBrowser(url: string): void {
  if ((process.env.VALHALLA_OPEN_BROWSER ?? "true").toLowerCase() === "false") return;
  if (process.env.VALHALLA_BIND && process.env.VALHALLA_BIND !== "127.0.0.1") return;
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // A missing browser opener must not stop the desk.
  }
}

const engine = new AgentEngine(process.env.VALHALLA_DATA_DIR || path.join(process.cwd(), "data"));
const desk = await startDashboard(engine);
const url = `http://127.0.0.1:${desk.port}`;

console.log(`Valhalla desk is on ${url}`);
console.log("Keys stay on this PC. Live trading stays off until you arm it in the app.");
if (process.env.VALHALLA_BIND === "0.0.0.0") {
  console.log("The phone can pair on your network. Send and withdraw stay blocked.");
}
openBrowser(url);

async function stop(): Promise<void> {
  await desk.close();
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
