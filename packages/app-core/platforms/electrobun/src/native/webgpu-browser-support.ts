import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBrandConfig } from "../brand-config";

export interface WebGpuSupportStatus {
	/** Whether WebGPU is expected to be available in the webview renderer. */
	available: boolean;
	/** Human-readable explanation of the status. */
	reason: string;
	/** Which renderer backend is active (native = WKWebView, cef = Chromium). */
	renderer: "native" | "cef" | "unknown";
	/** Path to Chrome Beta if found on disk. */
	chromeBetaPath: string | null;
	/** URL to download Chrome Beta for this platform. */
	downloadUrl: string | null;
}

export interface ChromeBetaDetection {
	/** Whether Chrome Beta was found on disk. */
	found: boolean;
	/** Absolute path to the Chrome Beta executable, or null. */
	path: string | null;
	/** Platform-specific download URL for Chrome Beta. */
	downloadUrl: string;
}

const CHROME_BETA_PATHS: Record<string, string[]> = {
	darwin: [
		"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
	],
	linux: [
		"/usr/bin/google-chrome-beta",
		"/opt/google/chrome-beta/google-chrome-beta",
	],
	win32: [
		// %LOCALAPPDATA%\Google\Chrome Beta\Application\chrome.exe
		path.join(
			process.env.LOCALAPPDATA ?? "",
			"Google",
			"Chrome Beta",
			"Application",
			"chrome.exe",
		),
		// Fallback for x86 program files
		path.join(
			process.env.PROGRAMFILES ?? "C:\\Program Files",
			"Google",
			"Chrome Beta",
			"Application",
			"chrome.exe",
		),
		path.join(
			process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
			"Google",
			"Chrome Beta",
			"Application",
			"chrome.exe",
		),
	],
};

const CHROME_BETA_DOWNLOAD_URLS: Record<string, string> = {
	darwin: "https://www.google.com/chrome/beta/",
	linux: "https://www.google.com/chrome/beta/",
	win32: "https://www.google.com/chrome/beta/",
};

/**
 * Locate Chrome Beta on the current platform.
 */
export function detectChromeBeta(): ChromeBetaDetection {
	const platform = process.platform;
	const candidates = CHROME_BETA_PATHS[platform] ?? [];
	const downloadUrl =
		CHROME_BETA_DOWNLOAD_URLS[platform] ??
		"https://www.google.com/chrome/beta/";

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return { found: true, path: candidate, downloadUrl };
			}
		} catch {
			// Permission errors etc. — try next candidate
		}
	}

	return { found: false, path: null, downloadUrl };
}

/**
 * Returns the platform-specific download URL for Chrome Beta.
 */
export function getChromeBetaDownloadUrl(): string {
	return (
		CHROME_BETA_DOWNLOAD_URLS[process.platform] ??
		"https://www.google.com/chrome/beta/"
	);
}

/**
 * Returns the Chromium command-line flags needed to enable WebGPU.
 * These are only applicable to CEF or Chrome Beta — WKWebView does
 * not use Chromium flags.
 */
export function getWebGpuChromiumFlags(): string[] {
	const flags = ["--enable-unsafe-webgpu"];

	if (process.platform === "linux") {
		flags.push("--enable-features=Vulkan");
		flags.push("--use-angle=vulkan");
	}

	return flags;
}

/**
 * Returns the macOS **marketing** major (11, 12, … 26, 27, …), derived from
 * `os.release()`’s Darwin major (same as `uname -r`).
 *
 * **Documented mapping** (Darwin release history; e.g. Wikipedia
 * “Darwin (operating system)” § Darwin 20 onwards, checked 2026-03):
 *
 * | Darwin | macOS |
 * |-------:|------:|
 * | 20 | 11 Big Sur |
 * | 21 | 12 Monterey |
 * | 22 | 13 Ventura |
 * | 23 | 14 Sonoma |
 * | 24 | 15 Sequoia |
 * | 25 | 26 Tahoe |
 *
 * For Darwin 20–24: `macOS = Darwin − 9`. From Tahoe onward the product major
 * is **Darwin + 1** (build numbers still start with Darwin); see
 * https://derflounder.wordpress.com/2025/12/24/why-macos-26-build-numbers-begin-with-25/
 * — so Darwin 26 → macOS 27 when that ships, etc.
 *
 * Darwin majors below 20 (macOS 10.x and earlier): returns `null` (not needed for WebGPU).
 */
export function getMacOSMajorVersion(): number | null {
	if (process.platform !== "darwin") return null;
	try {
		const release = os.release(); // e.g. "25.0.0" on macOS 26 (Darwin 25)
		const darwinMajor = Number.parseInt(release.split(".")[0], 10);
		if (Number.isNaN(darwinMajor)) return null;
		if (darwinMajor >= 25) {
			return darwinMajor + 1;
		}
		if (darwinMajor >= 20) {
			return darwinMajor - 9;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Check WebGPU support for the current platform and renderer.
 *
 * @param rendererType - The active renderer ("native" for WKWebView, "cef" for Chromium)
 */
export function checkWebGpuSupport(
	rendererType: "native" | "cef" = process.platform === "darwin"
		? "native"
		: "cef",
): WebGpuSupportStatus {
	const chromeBeta = detectChromeBeta();

	// macOS with WKWebView (native renderer)
	if (process.platform === "darwin" && rendererType === "native") {
		const macVersion = getMacOSMajorVersion();

		if (macVersion !== null && macVersion >= 26) {
			return {
				available: true,
				reason:
					"WebGPU is natively supported in WKWebView on macOS 26+ (Tahoe).",
				renderer: "native",
				chromeBetaPath: chromeBeta.path,
				downloadUrl: null,
			};
		}

		// macOS < 26 — WKWebView doesn't expose WebGPU (the app still runs; UI uses WebGL).
		return {
			available: false,
			reason: `WKWebView does not expose WebGPU on macOS ${macVersion ?? "unknown"} (native navigator.gpu needs macOS 26+ Tahoe). ${getBrandConfig().appName} still runs; companion and avatar use WebGL when WebGPU is missing. Chrome Beta is optional for separate Chromium WebGPU experiments.`,
			renderer: "native",
			chromeBetaPath: chromeBeta.path,
			downloadUrl: chromeBeta.downloadUrl,
		};
	}

	// Linux / Windows with CEF
	if (rendererType === "cef") {
		// CEF needs --enable-unsafe-webgpu which we can't inject yet
		// (upstream Electrobun feature needed)
		const flags = getWebGpuChromiumFlags();
		const flagList = flags.join(", ");

		return {
			available: false,
			reason: `CEF needs WebGPU-related Chromium flags (${flagList}); injecting them from ${getBrandConfig().appName} is pending upstream Electrobun support. ${chromeBeta.found ? "Chrome Beta is installed for optional WebGPU testing." : "Chrome Beta is not installed."} The ${getBrandConfig().appName} UI still runs on WebGL when the renderer has no WebGPU.`,
			renderer: "cef",
			chromeBetaPath: chromeBeta.path,
			downloadUrl: chromeBeta.found ? null : chromeBeta.downloadUrl,
		};
	}

	// Unknown / fallback
	return {
		available: false,
		reason: `Unable to determine WebGPU support for this configuration. ${getBrandConfig().appName} still runs; the UI uses WebGL when WebGPU is unavailable.`,
		renderer: "unknown",
		chromeBetaPath: chromeBeta.path,
		downloadUrl: chromeBeta.downloadUrl,
	};
}
