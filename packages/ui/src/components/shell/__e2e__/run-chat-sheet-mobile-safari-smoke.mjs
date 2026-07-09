/**
 * Real Mobile Safari visual smoke for the continuous-chat sheet.
 *
 * This is intentionally a visual simulator smoke, not a gesture automation
 * suite: plain `xcrun simctl` can boot/open/capture Mobile Safari, but does not
 * expose tap/swipe primitives. Gesture assertions stay in the Playwright WebKit
 * lane; this script proves the generated fixture renders in actual Mobile
 * Safari chrome on an iOS Simulator and captures the screen as evidence.
 *
 * Run:
 *   bun run --cwd packages/ui test:chat-sheet-mobile-safari-smoke
 *
 * Optional env:
 *   IOS_SIMULATOR_UDID=<device udid>
 *   IOS_SIMULATOR_NAME="iPhone 16 Pro"
 *   MOBILE_SAFARI_SMOKE_PORT=8765
 *   MOBILE_SAFARI_SMOKE_HOST=<host address visible to the simulator>
 */

import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../../../..");
const fixtureDir = join(here, "output-webkit");
const fixtureHtml = join(fixtureDir, "chat-sheet.html");
const mobileOutputDir = join(here, "output-mobile-safari");
const screenshotPath = join(mobileOutputDir, "mobile-safari-closed.png");
const port = Number.parseInt(process.env.MOBILE_SAFARI_SMOKE_PORT ?? "8765", 10);
const requestedName = process.env.IOS_SIMULATOR_NAME ?? "iPhone 16 Pro";

function log(message) {
  console.log(`[mobile-safari] ${message}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code, stdout, stderr });
      } else {
        const rendered = [command, ...args].join(" ");
        reject(new Error(`${rendered} exited with ${code}\n${stderr}`));
      }
    });
  });
}

function hostAddress() {
  if (process.env.MOBILE_SAFARI_SMOKE_HOST) {
    return process.env.MOBILE_SAFARI_SMOKE_HOST;
  }
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "localhost";
}

async function selectDevice() {
  if (process.env.IOS_SIMULATOR_UDID) return process.env.IOS_SIMULATOR_UDID;

  const { stdout } = await run(
    "xcrun",
    ["simctl", "list", "devices", "available", "--json"],
    { capture: true },
  );
  const parsed = JSON.parse(stdout);
  const runtimes = Object.entries(parsed.devices ?? {}).filter(([runtime]) =>
    runtime.includes("iOS"),
  );
  const allIosDevices = runtimes.flatMap(([, devices]) => devices);
  const named = allIosDevices.find((device) => device.name === requestedName);
  const fallback = allIosDevices.find((device) => device.name?.startsWith("iPhone"));
  const selected = named ?? fallback;
  if (!selected?.udid) {
    throw new Error(
      `No available iOS Simulator found. Tried IOS_SIMULATOR_NAME=${JSON.stringify(
        requestedName,
      )}.`,
    );
  }
  return selected.udid;
}

function contentType(path) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

async function serveFixture() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const name = basename(url.pathname === "/" ? "chat-sheet.html" : url.pathname);
    const file = join(fixtureDir, name);
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": contentType(file),
        "cache-control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  return server;
}

async function assertRenderedContent(path) {
  const image = PNG.sync.read(await readFile(path));
  let darkPixels = 0;
  let saturatedPixels = 0;
  for (let y = 120; y < image.height - 260; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (image.width * y + x) << 2;
      const r = image.data[offset];
      const g = image.data[offset + 1];
      const b = image.data[offset + 2];
      if (r < 80 && g < 80 && b < 110) darkPixels += 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 40) saturatedPixels += 1;
    }
  }
  if (darkPixels < 10_000 && saturatedPixels < 10_000) {
    throw new Error(
      `Mobile Safari screenshot appears blank or did not render the fixture (darkPixels=${darkPixels}, saturatedPixels=${saturatedPixels})`,
    );
  }
}

async function main() {
  log("building WebKit fixture via Playwright smoke");
  await run(process.execPath, ["run", "--cwd", "packages/ui", "test:chat-sheet-safari-e2e"]);
  await stat(fixtureHtml);

  const udid = await selectDevice();
  log(`using simulator ${udid}`);

  log("booting simulator");
  const boot = await run("xcrun", ["simctl", "boot", udid], {
    allowFailure: true,
    capture: true,
  });
  if (boot.code !== 0 && !/current state: Booted|Unable to boot device in current state/i.test(boot.stderr)) {
    throw new Error(`xcrun simctl boot failed:\n${boot.stderr}`);
  }
  await run("xcrun", ["simctl", "bootstatus", udid, "-b"]);

  await mkdir(mobileOutputDir, { recursive: true });
  const server = await serveFixture();
  try {
    const url = `http://${hostAddress()}:${port}/chat-sheet.html`;
    log(`opening Mobile Safari: ${url}`);
    await run("xcrun", ["simctl", "openurl", udid, url]);
    await new Promise((resolve) => setTimeout(resolve, 3500));

    log(`capturing screenshot: ${screenshotPath}`);
    await run("xcrun", ["simctl", "io", udid, "screenshot", screenshotPath]);
    const shot = await stat(screenshotPath);
    if (shot.size < 10_000) {
      throw new Error(`screenshot looked too small (${shot.size} bytes)`);
    }
    await assertRenderedContent(screenshotPath);
    log(`PASS: Mobile Safari screenshot written to ${screenshotPath}`);
    log("Note: simctl cannot automate Safari gestures; use Playwright WebKit for gesture assertions.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
