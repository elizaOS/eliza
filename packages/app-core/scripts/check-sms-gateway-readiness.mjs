#!/usr/bin/env node
/**
 * Snapshot the remaining readiness gates for the shared Eliza Cloud SMS gateway.
 *
 * This command is read-only: it does not send SMS and does not modify macOS,
 * Android, BlueBubbles, or cloud state.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const packagesRoot = path.resolve(scriptDir, "..", "..");
const homepageScript = path.join(scriptDir, "check-homepage-public-readiness.mjs");
const installScript = path.join(scriptDir, "install-android-sms-gateway.mjs");
const cloudOnboardingScript = path.join(scriptDir, "verify-cloud-sms-onboarding-flow.mjs");
const routingContractTests = [
  path.join(
    packagesRoot,
    "cloud-shared",
    "src",
    "lib",
    "services",
    "phone-gateway-devices.test.ts",
  ),
  path.join(
    packagesRoot,
    "cloud-shared",
    "src",
    "lib",
    "services",
    "agent-gateway-router.test.ts",
  ),
  path.join(
    packagesRoot,
    "cloud-shared",
    "src",
    "lib",
    "services",
    "message-router",
    "index.test.ts",
  ),
];
const adbPath = "/opt/homebrew/share/android-commandlinetools/platform-tools/adb";
const bridgeUrl = "http://127.0.0.1:8795";
const onboardingContinuationUrl =
  "https://elizaos-homepage.pages.dev/get-started/?onboardingSession=readiness-smoke";
let blocked = false;

function run(command, args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function curlText(url) {
  return run("curl", ["-sS", "-L", "--max-time", "20", url]);
}

function printSection(title, result) {
  console.log(`\n=== ${title} ===`);
  if (result.stdout.trim()) console.log(result.stdout.trim());
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.status !== 0) {
    console.error(`[sms-gateway-readiness] ${title} exited with ${result.status}`);
    blocked = true;
  }
}

function printGateSection(title, result, blockedPattern) {
  printSection(title, result);
  if (result.status === 0 && blockedPattern.test(result.stdout)) {
    console.error(`[sms-gateway-readiness] ${title} has blocked checks`);
    blocked = true;
  }
}

function usbInventoryFromIoreg() {
  const result = run("ioreg", ["-p", "IOUSB", "-l", "-w", "0"]);
  if (result.status !== 0) return result;

  const devices = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const nameMatch = line.match(/"USB Product Name"\s*=\s*"([^"]+)"/);
    const registryMatch = line.match(/\+\-o\s+([^@<]+)@/);
    const name = nameMatch?.[1] ?? registryMatch?.[1];
    if (!name) continue;
    const trimmed = name.trim();
    if (!trimmed || /Root Hub|XHCI|\bUSB\s*(?:3\.|2\.|1\.|Bus)\b/i.test(trimmed)) {
      continue;
    }
    if (!devices.includes(trimmed)) devices.push(trimmed);
  }

  const phoneLike = devices.filter((name) =>
    /\b(Android|ADB|MTP|Pixel|Samsung|Galaxy|Motorola|Moto|OnePlus|Xiaomi|Redmi|OPPO|Vivo|Nothing|Nokia|Sony|LG|HTC|Huawei|iPhone)\b/i.test(
      name,
    ),
  );

  return {
    status: phoneLike.length > 0 ? 0 : 1,
    stdout:
      phoneLike.length > 0
        ? phoneLike.slice(0, 10).join("\n")
        : devices.length > 0
          ? `USB devices visible but none look like an Android phone:\n${devices.slice(0, 10).join("\n")}`
          : "no USB devices enumerated by ioreg",
    stderr: "",
  };
}

function printHostUsbState() {
  const fallback = usbInventoryFromIoreg();
  printSection("host usb", {
    status: fallback.status,
    stdout: fallback.stdout.trim()
      ? fallback.stdout.trim()
      : fallback.stdout,
    stderr: fallback.stderr.trim(),
  });
}

function fetchDeployedGetStartedChunk(body) {
  const indexMatch = body.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/);
  if (!indexMatch) {
    return {
      status: 1,
      stdout: "",
      stderr: "could not find deployed index asset in onboarding app shell",
    };
  }

  const indexAssetUrl = new URL(indexMatch[1], onboardingContinuationUrl).href;
  const indexAsset = curlText(indexAssetUrl);
  if (indexAsset.status !== 0) return indexAsset;

  const getStartedMatch = indexAsset.stdout.match(
    /(?:assets\/|\.\.?\/)?(get-started-[A-Za-z0-9_-]+\.js)/,
  );
  if (!getStartedMatch) {
    return {
      status: 1,
      stdout: `index=${indexAssetUrl}`,
      stderr: "could not find deployed get-started chunk reference",
    };
  }

  const chunkUrl = new URL(`/assets/${getStartedMatch[1]}`, onboardingContinuationUrl).href;
  const chunk = curlText(chunkUrl);
  if (chunk.status !== 0) return chunk;

  return {
    status: 0,
    stdout: chunk.stdout,
    stderr: chunk.stderr,
    url: chunkUrl,
  };
}

function printOnboardingContinuationState() {
  const result = run("curl", [
    "-sS",
    "-L",
    "--max-time",
    "20",
    "-w",
    "\n%{http_code} %{url_effective}",
    onboardingContinuationUrl,
  ]);
  if (result.status !== 0) {
    printSection("onboarding continuation", result);
    return;
  }

  const lines = result.stdout.split(/\r?\n/);
  const statusLine = lines.pop() ?? "";
  const body = lines.join("\n");
  const [httpCode, effectiveUrl] = statusLine.split(/\s+/, 2);
  const hasAppShell = body.includes('id="root"') && body.includes("/assets/index-");
  const chunk = hasAppShell
    ? fetchDeployedGetStartedChunk(body)
    : { status: 1, stdout: "", stderr: "app shell missing" };
  const hasOnboardingSession = chunk.stdout.includes("onboardingSession");
  const hasOnboardingChatApi = chunk.stdout.includes("/api/eliza-app/first-run/chat");
  const hasBlooioPlatform = chunk.stdout.includes("blooio");
  const passed =
    httpCode === "200" &&
    effectiveUrl?.startsWith("https://elizaos-homepage.pages.dev/get-started/") &&
    hasAppShell &&
    chunk.status === 0 &&
    hasOnboardingSession &&
    hasOnboardingChatApi &&
    hasBlooioPlatform;
  printSection("onboarding continuation", {
    status: passed ? 0 : 1,
    stdout:
      `url=${effectiveUrl || onboardingContinuationUrl} status=${httpCode || "unknown"} app-shell=${hasAppShell ? "yes" : "no"}` +
      ` chunk=${chunk.url ?? "unknown"} onboardingSession=${hasOnboardingSession ? "yes" : "no"}` +
      ` onboardingChatApi=${hasOnboardingChatApi ? "yes" : "no"} platform=blooio:${hasBlooioPlatform ? "yes" : "no"}`,
    stderr: [result.stderr.trim(), chunk.stderr?.trim()].filter(Boolean).join("\n"),
  });
}

function printAndroidState() {
  printGateSection("android doctor", run("node", [installScript, "--doctor"]), /\bBLOCKED\b/);
  printSection("adb devices", run(adbPath, ["devices", "-l"]));
  printHostUsbState();
}

function printBridgeState() {
  printGateSection(
    "bluebubbles doctor",
    run("curl", ["-sS", `${bridgeUrl}/doctor`]),
    /"status"\s*:\s*"blocked"/,
  );
  printSection(
    "bluebubbles pending replies",
    run("curl", ["-sS", `${bridgeUrl}/pending-replies`]),
  );
}

function createRoutingContractCwd() {
  const tmpRoot = path.join(repoRoot, ".tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(tmpRoot, "sms-gateway-routing-"));
  fs.writeFileSync(
    path.join(cwd, "bunfig.toml"),
    "[test]\ntimeout = 60000\ncoverage = false\n",
  );
  return cwd;
}

function printRoutingContractState() {
  const cwd = createRoutingContractCwd();
  try {
    for (const testPath of routingContractTests) {
      printSection(
        `routing contract: ${path.relative(packagesRoot, testPath)}`,
        run("bun", ["test", testPath], { cwd }),
      );
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

printSection("homepage public readiness", run("node", [homepageScript]));
printOnboardingContinuationState();
printSection("cloud sms onboarding", run("node", [cloudOnboardingScript]));
printRoutingContractState();
printAndroidState();
printBridgeState();

if (blocked) {
  process.exitCode = 1;
}
