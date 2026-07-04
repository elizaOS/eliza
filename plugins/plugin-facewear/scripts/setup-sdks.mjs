#!/usr/bin/env node
/**
 * plugins/plugin-facewear/scripts/setup-sdks.mjs
 *
 * Checks that all facewear SDK dependencies are in place.
 * Run manually: bun run scripts/setup-sdks.mjs
 * On postinstall: called with --check-only (no downloads, just diagnostic output)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check-only");

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const _RED = "\x1b[31m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function ok(msg) {
	console.log(`${GREEN}✓${RESET} ${msg}`);
}
function warn(msg) {
	console.log(`${YELLOW}⚠${RESET} ${msg}`);
}
function info(msg) {
	console.log(`  ${msg}`);
}
function header(msg) {
	console.log(`\n${BOLD}${msg}${RESET}`);
}

function hasCommand(cmd) {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// ── Android SDK (needed for Quest + XReal + Even Realities APKs) ───────────────
header("Android SDK (Meta Quest, XReal, Even Realities APKs)");
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (androidHome && existsSync(androidHome)) {
	ok(`ANDROID_HOME=${androidHome}`);
} else {
	warn("ANDROID_HOME not set or directory not found");
	info("Install Android Studio: https://developer.android.com/studio");
	info("Then set: export ANDROID_HOME=$HOME/Library/Android/sdk  (macOS)");
	info("           export ANDROID_HOME=$HOME/Android/Sdk          (Linux)");
}

const javaOk = hasCommand("java");
if (javaOk) {
	try {
		const jver = execSync("java -version 2>&1").toString().split("\n")[0];
		ok(`Java: ${jver}`);
	} catch {
		ok("Java found");
	}
} else {
	warn("Java not found — required for Gradle Android builds");
	info("Install: https://adoptium.net/ (Java 17 recommended)");
}

// ── Bubblewrap CLI (Meta Quest TWA) ────────────────────────────────────────────
header("Bubblewrap CLI (Meta Quest 3 TWA)");
if (hasCommand("bubblewrap")) {
	ok("bubblewrap CLI installed");
} else {
	warn("bubblewrap CLI not found");
	info("Install: npm install -g @bubblewrap/cli");
	info("Then run: cd native/android/quest && bubblewrap build");
}

// ── XREAL SDK ──────────────────────────────────────────────────────────────────
header("XREAL SDK 3.0.0 (XReal native app)");
const xrealLibs = resolve(pluginRoot, "native/android/xreal/app/libs");
if (existsSync(xrealLibs)) {
	const hasAar =
		existsSync(resolve(xrealLibs, "nrsdk3.aar")) ||
		existsSync(resolve(xrealLibs, "xreal-sdk.aar"));
	if (hasAar) {
		ok("XREAL SDK AAR found in app/libs");
	} else {
		warn("XREAL SDK AAR not found in native/android/xreal/app/libs/");
		info("Download XREAL SDK 3.0.0 from https://developer.xreal.com/");
		info(
			"Place nrsdk3.aar in plugins/plugin-facewear/native/android/xreal/app/libs/",
		);
	}
} else {
	warn("native/android/xreal/app/libs/ not found");
	info("Run the plugin-facewear build first to create native app structure");
}

// ── Even Realities (BLE — no external SDK needed) ─────────────────────────────
header("Even Realities G1/G2 (BLE — built-in protocol)");
ok("Even Realities G1/G2 protocol is built into plugin-facewear");
info("For Node/Bun: Noble BLE transport — npm install @abandonware/noble");
const nobleInstalled = existsSync(
	resolve(pluginRoot, "../../node_modules/@abandonware/noble"),
);
if (nobleInstalled) {
	ok("@abandonware/noble installed");
} else {
	warn("@abandonware/noble not installed (optional — for CLI BLE)");
	info("Install: bun add -d @abandonware/noble");
}

// ── visionOS / Xcode (Apple Vision Pro) ────────────────────────────────────────
header("visionOS SDK / Xcode (Apple Vision Pro)");
if (platform() !== "darwin") {
	warn("visionOS SDK requires macOS + Xcode — skipping on this platform");
} else {
	if (hasCommand("xcodebuild")) {
		try {
			const ver = execSync("xcodebuild -version 2>&1")
				.toString()
				.split("\n")[0];
			const match = ver.match(/Xcode (\d+)/);
			const majorVer = match ? parseInt(match[1], 10) : 0;
			if (majorVer >= 16) {
				ok(`${ver}`);
			} else {
				warn(`${ver} — Xcode 16+ required for visionOS 2.4 SDK`);
				info("Update via App Store or https://developer.apple.com/xcode/");
			}
		} catch {
			ok("Xcode found");
		}
	} else {
		warn("Xcode not found");
		info("Install Xcode 16+ from the Mac App Store");
	}

	// Check Vision Pro Simulator
	const simPath =
		"/Library/Developer/CoreSimulator/Profiles/Runtimes/visionOS.simruntime";
	if (existsSync(simPath)) {
		ok("Apple Vision Pro Simulator installed");
	} else {
		warn("Apple Vision Pro Simulator not found");
		info("In Xcode: Platforms & Simulators → download visionOS");
	}
}

// ── VR/AR Runtime (OpenXR — desktop WebXR) ─────────────────────────────────────
// WebKitGTK (Linux desktop) and Chromium (Windows) ship the WebXR Device API, but
// `navigator.xr` only reaches a headset when an OpenXR runtime (Monado / SteamVR /
// WMR) is installed and active. This mirrors src/runtime/openxr-runtime.ts.
header("VR/AR Runtime (OpenXR — Monado / SteamVR, for desktop WebXR)");
const osPlatform = platform();
const doInstall = process.argv.includes("--install") && !checkOnly;

function readActiveRuntime(path) {
	try {
		const json = JSON.parse(readFileSync(path, "utf8"));
		return json?.runtime?.library_path ? json.runtime : null;
	} catch {
		return null;
	}
}

if (osPlatform === "darwin") {
	warn(
		"macOS uses native WebXR on visionOS Safari — no OpenXR runtime to install.",
	);
} else if (osPlatform === "linux") {
	const xdg =
		process.env.XDG_CONFIG_HOME || resolve(process.env.HOME ?? "~", ".config");
	const candidates = [
		process.env.XR_RUNTIME_JSON,
		resolve(xdg, "openxr/1/active_runtime.json"),
		"/etc/xdg/openxr/1/active_runtime.json",
		"/usr/local/share/openxr/1/active_runtime.json",
		"/usr/share/openxr/1/active_runtime.json",
	].filter(Boolean);
	const active = candidates.find((p) => existsSync(p) && readActiveRuntime(p));
	if (active) {
		const lib = readActiveRuntime(active)?.library_path ?? "";
		ok(`Active OpenXR runtime: ${active}${lib ? ` → ${lib}` : ""}`);
	} else {
		warn(
			"No active OpenXR runtime — immersive WebXR won't reach a headset yet.",
		);
		info(
			"Easiest (no root, if you use Steam):  steam steam://install/250820  # SteamVR",
		);
		info(
			"Monado (open source):  sudo apt-get install -y libopenxr-loader1 libopenxr1-monado monado",
		);
		info("Then run the compositor:  monado-service");
		if (doInstall && hasCommand("steam")) {
			info("Installing SteamVR via Steam…");
			try {
				execSync("steam steam://install/250820", { stdio: "inherit" });
				ok("SteamVR install requested via Steam");
			} catch {
				warn(
					"Could not launch Steam install — run the command above manually.",
				);
			}
		} else if (doInstall) {
			warn(
				"Steam not found; Monado needs root (sudo) — run the apt command above.",
			);
		}
	}
} else if (osPlatform === "win32") {
	let active = process.env.XR_RUNTIME_JSON;
	if (!active) {
		try {
			const out = execSync(
				'reg query "HKLM\\SOFTWARE\\Khronos\\OpenXR\\1" /v ActiveRuntime',
			).toString();
			const line = out.split(/\r?\n/).find((l) => l.includes("ActiveRuntime"));
			active = line
				?.trim()
				.split(/\s{2,}|\t/)
				.pop();
		} catch {
			active = undefined;
		}
	}
	if (active && existsSync(active)) {
		ok(`Active OpenXR runtime: ${active}`);
	} else {
		warn("No active OpenXR runtime registered.");
		info("Install SteamVR:  steam steam://install/250820");
		info(
			"Or 'OpenXR Tools for Windows Mixed Reality' from the Microsoft Store.",
		);
	}
}

// ── Summary ────────────────────────────────────────────────────────────────────
header("Summary");
info("Run 'bun run setup:sdks' from the plugin root for full setup.");
info(
	"Add '--install' to attempt the no-root SteamVR install on Linux/Windows.",
);
info("See DEVICES.md for per-device setup guides.");
console.log("");
