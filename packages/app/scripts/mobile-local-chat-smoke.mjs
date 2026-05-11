#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const appConfigPath = path.join(repoRoot, "packages/app/app.config.ts");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const platform = argValue("--platform") ?? "ios";
const apiBase = argValue("--api-base");
const authTokenArg = argValue("--auth-token");
const requireInstalled = process.argv.includes("--require-installed");
const live = process.argv.includes("--live") || Boolean(apiBase);
const androidSelectLocal = process.argv.includes("--android-select-local");
const androidBackground = process.argv.includes("--android-background");
const ANDROID_HEALTH_ATTEMPTS = 240;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function executablePath(...candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function appId() {
  const config = fs.readFileSync(appConfigPath, "utf8");
  return config.match(/appId:\s*["']([^"']+)["']/)?.[1] ?? "app.eliza";
}

function androidSdkRoot() {
  return (
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(os.homedir(), "Library/Android/sdk")
  );
}

function androidTool(relativePath, fallbackName) {
  return executablePath(
    path.join(androidSdkRoot(), relativePath),
    fallbackName,
  );
}

function adbPath() {
  return androidTool("platform-tools/adb", "adb");
}

function tryExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (requireInstalled && !options.allowFailure) {
      throw error;
    }
    return null;
  }
}

function requireExec(command, args, label) {
  const output = tryExec(command, args);
  if (output === null) {
    throw new Error(label ?? `${command} ${args.join(" ")} failed`);
  }
  return output;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchIosSimulatorApp() {
  const booted = tryExec("xcrun", ["simctl", "list", "devices", "booted"]);
  if (!booted) {
    console.warn("[local-chat-smoke] No booted iOS simulator found.");
    return;
  }

  const id = appId();
  const container = tryExec("xcrun", [
    "simctl",
    "get_app_container",
    "booted",
    id,
    "app",
  ]);
  if (!container) {
    console.warn(
      `[local-chat-smoke] ${id} is not installed in the booted simulator.`,
    );
    return;
  }

  console.log(`[local-chat-smoke] Launching ${id} in the booted simulator.`);
  tryExec("xcrun", ["simctl", "launch", "booted", id]);
  tryExec("xcrun", ["simctl", "openurl", "booted", "elizaos://chat"]);
}

function androidDeviceSerial(adb) {
  const devices = requireExec(
    adb,
    ["devices"],
    "No Android device or emulator is available.",
  );
  const line = devices
    .split("\n")
    .slice(1)
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith("\tdevice"));
  if (!line) return null;
  return line.split(/\s+/)[0];
}

function launchAndroidEmulatorApp() {
  const adb = adbPath();
  if (!adb) {
    const message =
      "[local-chat-smoke] Android SDK platform-tools/adb was not found.";
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return null;
  }

  const serial = androidDeviceSerial(adb);
  if (!serial) {
    const message = "[local-chat-smoke] No booted Android emulator found.";
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return null;
  }

  const id = appId();
  const packagePath = tryExec(adb, ["-s", serial, "shell", "pm", "path", id]);
  if (!packagePath) {
    const message = `[local-chat-smoke] ${id} is not installed on ${serial}.`;
    if (requireInstalled) throw new Error(message);
    console.warn(message);
    return { adb, serial, installed: false };
  }

  console.log(`[local-chat-smoke] Launching ${id} on ${serial}.`);
  requireExec(
    adb,
    ["-s", serial, "shell", "am", "start", "-n", `${id}/.MainActivity`],
    `Failed to launch ${id} on ${serial}.`,
  );
  tryExec(adb, [
    "-s",
    serial,
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    "elizaos://chat",
    id,
  ]);
  return { adb, serial, installed: true };
}

function androidScreenSize(context) {
  const output = tryExec(context.adb, [
    "-s",
    context.serial,
    "shell",
    "wm",
    "size",
  ]);
  const match = output?.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) return { width: 1440, height: 2960 };
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10),
  };
}

function tapAndroidRatio(context, xRatio, yRatio) {
  const { width, height } = androidScreenSize(context);
  requireExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      "input",
      "tap",
      String(Math.round(width * xRatio)),
      String(Math.round(height * yRatio)),
    ],
    "Failed to tap Android emulator.",
  );
}

function readAndroidLocalAgentToken(context) {
  if (!context?.installed) return null;
  return tryExec(
    context.adb,
    [
      "-s",
      context.serial,
      "shell",
      "run-as",
      appId(),
      "cat",
      "files/auth/local-agent-token",
    ],
    { allowFailure: true },
  );
}

async function selectAndroidLocalRuntime(context) {
  if (!context?.installed) return;
  if (readAndroidLocalAgentToken(context)) return;
  console.log("[local-chat-smoke] Selecting Local runtime on Android.");
  await sleep(5000);
  // Current first-run flow: "I want to run it myself" -> "Use Local".
  tapAndroidRatio(context, 0.5, 0.695);
  await sleep(1500);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    tapAndroidRatio(context, 0.29, 0.675);
    await sleep(2500);
    if (readAndroidLocalAgentToken(context)) return;
  }
}

async function waitForAndroidApi(context) {
  if (!context?.installed) return null;

  let token = authTokenArg;
  let forwardedApiBase = null;
  let tokenRejectedAttempts = 0;
  for (let attempt = 1; attempt <= ANDROID_HEALTH_ATTEMPTS; attempt += 1) {
    if (!token) {
      token = readAndroidLocalAgentToken(context);
    }
    if (token) {
      if (!forwardedApiBase) {
        const forwardedPort = requireExec(
          context.adb,
          ["-s", context.serial, "forward", "tcp:0", "tcp:31337"],
          "Failed to forward Android local-agent port.",
        );
        forwardedApiBase = `http://127.0.0.1:${forwardedPort.trim()}`;
        console.log(
          `[local-chat-smoke] Android local-agent forwarded to ${forwardedApiBase}.`,
        );
      }
      try {
        const health = await requestJson(
          "GET",
          "/api/health",
          undefined,
          forwardedApiBase,
          token,
        );
        const status = await requestJson(
          "GET",
          "/api/status",
          undefined,
          forwardedApiBase,
          token,
        );
        console.log("[local-chat-smoke] Android health:", health);
        console.log("[local-chat-smoke] Android status:", status);
        return { apiBase: forwardedApiBase, token };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("/api/status failed: 401") ||
          message.includes("Unauthorized")
        ) {
          tokenRejectedAttempts += 1;
          if (tokenRejectedAttempts >= 3) {
            throw new Error(
              "Android local-agent token was rejected by the protected /api/status route. " +
                "This usually means another installed Eliza app already owns device port 31337; " +
                "force-stop the conflicting package or uninstall it before running the smoke.",
            );
          }
        }
        if (attempt % 10 === 0) {
          console.warn(
            `[local-chat-smoke] Android agent not healthy/authenticated yet (${attempt}/${ANDROID_HEALTH_ATTEMPTS}): ${message}`,
          );
        }
      }
    } else if (attempt % 10 === 0) {
      console.warn(
        `[local-chat-smoke] Android local-agent token not available yet (${attempt}/${ANDROID_HEALTH_ATTEMPTS}).`,
      );
    }
    await sleep(2000);
  }
  throw new Error("Android local-agent API did not become healthy in time.");
}

async function verifyAndroidBackgroundApi(context, baseUrl, authToken) {
  if (!context?.installed) return;
  const id = appId();
  console.log("[local-chat-smoke] Sending Android app to background.");
  requireExec(
    context.adb,
    ["-s", context.serial, "shell", "input", "keyevent", "HOME"],
    "Failed to send Android emulator to home screen.",
  );
  await sleep(5000);
  const services = requireExec(
    context.adb,
    ["-s", context.serial, "shell", "dumpsys", "activity", "services", id],
    "Failed to inspect Android foreground services.",
  );
  if (
    !services.includes(`${id}/.ElizaAgentService`) ||
    !services.includes(`${id}/.GatewayConnectionService`) ||
    !services.includes("isForeground=true")
  ) {
    throw new Error(
      "Android local background services are not both running as foreground services.",
    );
  }
  const health = await requestJson(
    "GET",
    "/api/health",
    undefined,
    baseUrl,
    authToken,
  );
  if (health?.ready !== true || health?.agentState !== "running") {
    throw new Error(
      `Android background health check failed: ${JSON.stringify(health)}`,
    );
  }
  console.log("[local-chat-smoke] Android background health:", health);
}

async function requestJson(
  method,
  pathname,
  body,
  baseUrl = apiBase,
  authToken = authTokenArg,
) {
  const base = baseUrl.replace(/\/$/, "");
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (authToken) headers.Authorization = `Bearer ${authToken.trim()}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${text}`);
  }
  return data;
}

async function runLiveApiSmoke(baseUrl = apiBase, authToken = authTokenArg) {
  await requestJson("GET", "/api/health", undefined, baseUrl, authToken);
  const created = await requestJson(
    "POST",
    "/api/conversations",
    {
      title: "Simulator local chat smoke",
    },
    baseUrl,
    authToken,
  );
  const conversationId = created.conversation?.id;
  if (!conversationId) {
    throw new Error("Conversation creation did not return an id.");
  }

  const greeting = await requestJson(
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/greeting`,
    undefined,
    baseUrl,
    authToken,
  );
  if (String(greeting.text ?? "").includes("I'm running locally")) {
    throw new Error("Stale local-mode greeting is still present.");
  }

  const reply = await requestJson(
    "POST",
    `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { text: "download the default local model" },
    baseUrl,
    authToken,
  );
  const hub = await requestJson(
    "GET",
    "/api/local-inference/hub",
    undefined,
    baseUrl,
    authToken,
  );
  const activeStatus = String(hub.active?.status ?? "");
  const activeError = String(hub.active?.error ?? "");
  const downloads = Array.isArray(hub.downloads) ? hub.downloads : [];
  const hasActiveDownload = downloads.some((download) =>
    ["queued", "downloading", "verifying", "complete"].includes(
      String(download?.state ?? ""),
    ),
  );
  if (activeStatus === "error") {
    throw new Error(
      `Local inference hub is in error state: ${activeError || "unknown"}`,
    );
  }
  if (activeStatus !== "ready" && !hasActiveDownload) {
    throw new Error(
      `Local model is neither ready nor downloading (active=${activeStatus || "unknown"}, downloads=${downloads.length}).`,
    );
  }
  console.log("[local-chat-smoke] conversation:", conversationId);
  console.log("[local-chat-smoke] greeting:", greeting.text);
  console.log("[local-chat-smoke] reply:", reply.text);
  console.log(
    "[local-chat-smoke] local inference:",
    JSON.stringify({
      active: hub.active,
      downloads: hub.downloads,
      hardware: hub.hardware,
    }),
  );
}

async function main() {
  let androidContext = null;
  if (platform === "ios" || platform === "both") {
    launchIosSimulatorApp();
  }
  if (platform === "android" || platform === "both") {
    androidContext = launchAndroidEmulatorApp();
    if (androidSelectLocal) {
      await selectAndroidLocalRuntime(androidContext);
    }
  }

  if (apiBase) {
    await runLiveApiSmoke();
    return;
  }

  if (live && (platform === "android" || platform === "both")) {
    const androidApi = await waitForAndroidApi(androidContext);
    if (androidApi) {
      if (androidBackground) {
        await verifyAndroidBackgroundApi(
          androidContext,
          androidApi.apiBase,
          androidApi.token,
        );
      }
      await runLiveApiSmoke(androidApi.apiBase, androidApi.token);
    }
  }

  run(
    "bunx",
    [
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "src/api/ios-local-agent-kernel.local-inference.test.ts",
      "src/onboarding/auto-download-recommended.test.ts",
    ],
    { cwd: path.join(repoRoot, "packages/ui") },
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
