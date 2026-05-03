/**
 * Screen Capture Native Module for Electrobun
 *
 * Frame capture strategy:
 *
 * 1. App-window capture (default, no gameUrl):
 *    Uses native CLI screenshot tools to capture real pixel data from the screen.
 *    - macOS: `screencapture -x -t jpg <tmpPath>` (no sound, no shadow)
 *    - Linux: `scrot --quality 70 <tmpPath>`, falling back to ImageMagick `import`
 *    - Windows: PowerShell `System.Drawing.CopyFromScreen` for native capture.
 *    The temp JPEG file is read, POSTed to the stream endpoint, then deleted.
 *
 * 2. Game URL capture (gameUrl provided):
 *    Creates a BrowserWindow for the game URL and captures its canvas/video
 *    content via JS. No offscreen `paint` event in Electrobun, so we poll.
 *
 * The captured JPEG frames are POSTed to the stream endpoint (e.g.
 * /api/stream/frame). The MJPEG monitor (GET /api/stream/screen) on the agent
 * server receives these frames for live view.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow } from "electrobun/bun";
import { getBrandConfig } from "../brand-config";
import { DEFAULT_API_PORT } from "../constants";
import type { SendToWebview, WebviewEvalRpc } from "../types.js";

/**
 * Allow-list for game-capture URLs.
 * Only localhost, 127.0.0.1, and file:// origins are permitted.
 * External URLs are rejected to prevent a compromised renderer or malicious
 * IPC call from opening an invisible native window that loads arbitrary
 * external content with full desktop privileges.
 */
function isAllowedCaptureUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" ||
			parsed.protocol === "file:"
		);
	} catch {
		return false;
	}
}

type Webview = { rpc?: unknown };

export class ScreenCaptureManager {
	private frameCaptureActive = false;
	private frameCaptureTimer: ReturnType<typeof setInterval> | null = null;
	private frameCaptureWindow: BrowserWindow | null = null;
	private recordingProc: ReturnType<typeof Bun.spawn> | null = null;
	private recordingPath: string | null = null;
	private recordingStart: number | null = null;
	private recordingPaused = false;

	setSendToWebview(_fn: SendToWebview): void {
		// Screen capture posts directly to the HTTP endpoint; no webview push needed.
	}

	setMainWebview(_webview: Webview | null): void {
		// Native CLI capture does not use the webview reference; retained for RPC compat.
	}

	/**
	 * Override the capture target webview. Pass null to revert to mainWebview.
	 * Used when a StreamView is popped out to a separate window.
	 *
	 * NOTE: Since screen capture was moved to native CLI tools on all platforms
	 * (screencapture on macOS, PowerShell on Windows, scrot/import on Linux),
	 * this override is intentionally inert — frame capture always captures the
	 * full screen, not a specific webview. The setter is retained because it is
	 * wired into the RPC schema (screencapture:setCaptureTarget) and called by
	 * StreamView popout logic. Removing it would require coordinated changes
	 * across rpc-schema.ts, rpc-handlers.ts, electrobun-direct-rpc.ts, and the
	 * renderer.
	 */
	setCaptureTarget(_webview: Webview | null): void {
		// Intentionally inert — see docblock above.
	}

	async getSources() {
		return {
			sources: [{ id: "screen:0", name: "Entire Screen", thumbnail: "" }],
			available: true,
		};
	}

	async takeScreenshot(): Promise<{ available: boolean; data?: string }> {
		const tmpPath = path.join(
			os.tmpdir(),
			`elizaos-screenshot-${Date.now()}.png`,
		);
		try {
			let proc: ReturnType<typeof Bun.spawn>;
			if (process.platform === "darwin") {
				proc = Bun.spawn(["screencapture", "-x", "-t", "png", tmpPath], {
					stdout: "ignore",
					stderr: "ignore",
				});
			} else if (process.platform === "win32") {
				const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$gfx.Dispose()
$bmp.Save('${tmpPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`;
				proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psScript], {
					stdout: "ignore",
					stderr: "ignore",
				});
			} else {
				try {
					proc = Bun.spawn(["scrot", tmpPath], {
						stdout: "ignore",
						stderr: "ignore",
					});
					await proc.exited;
					if (!fs.existsSync(tmpPath)) {
						proc = Bun.spawn(["import", "-window", "root", tmpPath], {
							stdout: "ignore",
							stderr: "ignore",
						});
					}
				} catch {
					proc = Bun.spawn(["import", "-window", "root", tmpPath], {
						stdout: "ignore",
						stderr: "ignore",
					});
				}
			}

			await proc.exited;

			const actualPath = fs.existsSync(tmpPath)
				? tmpPath
				: fs.existsSync(`${tmpPath}.png`)
					? `${tmpPath}.png`
					: null;

			if (!actualPath) return { available: false };

			const data = fs.readFileSync(actualPath).toString("base64");
			return { available: true, data: `data:image/png;base64,${data}` };
		} catch {
			return { available: false };
		} finally {
			for (const p of [tmpPath, `${tmpPath}.png`]) {
				try {
					if (fs.existsSync(p)) fs.unlinkSync(p);
				} catch {}
			}
		}
	}

	async captureWindow(options?: {
		windowId?: string;
	}): Promise<{ available: boolean; data?: string }> {
		// macOS: use screencapture -l <windowId> if a windowId is provided.
		// Other platforms: fall back to full-screen capture.
		if (process.platform === "darwin" && options?.windowId) {
			const tmpPath = path.join(
				os.tmpdir(),
				`elizaos-window-${Date.now()}.png`,
			);
			try {
				const proc = Bun.spawn(
					["screencapture", "-x", "-t", "png", "-l", options.windowId, tmpPath],
					{ stdout: "ignore", stderr: "ignore" },
				);
				await proc.exited;
				const actualPath = fs.existsSync(tmpPath)
					? tmpPath
					: fs.existsSync(`${tmpPath}.png`)
						? `${tmpPath}.png`
						: null;
				if (actualPath) {
					const data = fs.readFileSync(actualPath).toString("base64");
					return { available: true, data: `data:image/png;base64,${data}` };
				}
			} catch {
				// Fall through to full-screen capture
			} finally {
				for (const p of [tmpPath, `${tmpPath}.png`]) {
					try {
						if (fs.existsSync(p)) fs.unlinkSync(p);
					} catch {}
				}
			}
		}
		// Fall back to full-screen capture
		return this.takeScreenshot();
	}

	async startRecording(): Promise<{ available: boolean; reason?: string }> {
		if (this.recordingProc) return { available: true };

		const outputPath = path.join(
			os.tmpdir(),
			`elizaos-recording-${Date.now()}.mp4`,
		);
		this.recordingPath = outputPath;
		this.recordingStart = Date.now();
		this.recordingPaused = false;

		try {
			if (process.platform === "darwin") {
				this.recordingProc = Bun.spawn(
					[
						"ffmpeg",
						"-y",
						"-f",
						"avfoundation",
						"-capture_cursor",
						"1",
						"-i",
						"1",
						outputPath,
					],
					{ stdout: "ignore", stderr: "ignore" },
				);
			} else if (process.platform === "linux") {
				this.recordingProc = Bun.spawn(
					["ffmpeg", "-y", "-f", "x11grab", "-i", ":0.0", outputPath],
					{ stdout: "ignore", stderr: "ignore" },
				);
			} else if (process.platform === "win32") {
				this.recordingProc = Bun.spawn(
					["ffmpeg", "-y", "-f", "gdigrab", "-i", "desktop", outputPath],
					{ stdout: "ignore", stderr: "ignore" },
				);
			} else {
				this.recordingPath = null;
				this.recordingStart = null;
				return {
					available: false,
					reason: "Screen recording not supported on this platform",
				};
			}
			return { available: true };
		} catch {
			this.recordingProc = null;
			this.recordingPath = null;
			this.recordingStart = null;
			return {
				available: false,
				reason: "ffmpeg not found — install ffmpeg to enable screen recording",
			};
		}
	}

	async stopRecording(): Promise<{ available: boolean; path?: string }> {
		if (!this.recordingProc) return { available: false };

		try {
			this.recordingProc.kill("SIGTERM");
			await this.recordingProc.exited;
		} catch {}

		this.recordingProc = null;
		this.recordingPaused = false;
		const savedPath = this.recordingPath;
		const duration = this.recordingStart
			? Math.floor((Date.now() - this.recordingStart) / 1000)
			: 0;
		this.recordingPath = null;
		this.recordingStart = null;

		if (savedPath && fs.existsSync(savedPath) && duration > 0) {
			return { available: true, path: savedPath };
		}
		return { available: false };
	}

	async pauseRecording(): Promise<{ available: boolean }> {
		if (!this.recordingProc || this.recordingPaused) {
			return { available: false };
		}
		try {
			this.recordingProc.kill("SIGSTOP");
			this.recordingPaused = true;
			return { available: true };
		} catch {
			return { available: false };
		}
	}

	async resumeRecording(): Promise<{ available: boolean }> {
		if (!this.recordingProc || !this.recordingPaused) {
			return { available: false };
		}
		try {
			this.recordingProc.kill("SIGCONT");
			this.recordingPaused = false;
			return { available: true };
		} catch {
			return { available: false };
		}
	}

	async getRecordingState(): Promise<{
		recording: boolean;
		duration: number;
		paused: boolean;
	}> {
		const recording = !!this.recordingProc;
		const duration =
			recording && this.recordingStart
				? Math.floor((Date.now() - this.recordingStart) / 1000)
				: 0;
		return { recording, duration, paused: this.recordingPaused };
	}

	/**
	 * Start frame capture and POST JPEGs to the stream endpoint.
	 *
	 * Two modes (mirrors the earlier desktop runtime):
	 *  - gameUrl provided: captures a dedicated BrowserWindow loading that URL
	 *  - no gameUrl: captures the main webview via JS canvas screenshot
	 */
	async startFrameCapture(options?: {
		fps?: number;
		quality?: number;
		apiBase?: string;
		endpoint?: string;
		gameUrl?: string;
	}): Promise<{ available: boolean; reason?: string }> {
		if (this.frameCaptureActive) return { available: true };

		const fps = options?.fps ?? 10;
		const quality = options?.quality ?? 70;
		const apiBase = options?.apiBase ?? `http://127.0.0.1:${DEFAULT_API_PORT}`;
		const endpointPath = options?.endpoint ?? "/api/stream/frame";
		const endpoint = `${apiBase}${endpointPath}`;
		const interval = Math.round(1000 / fps);

		this.frameCaptureActive = true;

		if (options?.gameUrl) {
			return this.startGameCapture(
				options.gameUrl,
				fps,
				quality,
				endpoint,
				interval,
			);
		}

		return this.startWebviewCapture(fps, quality, endpoint, interval);
	}

	/**
	 * App-window capture: uses native CLI tools to capture real screen pixels.
	 *
	 * macOS: `screencapture -x -t jpg <tmpPath>`
	 * Linux: `scrot --quality 70 <tmpPath>` (falls back to ImageMagick `import`)
	 * Windows: PowerShell System.Drawing screen capture
	 */
	private startWebviewCapture(
		_fps: number,
		quality: number,
		endpoint: string,
		interval: number,
	): { available: boolean; reason?: string } {
		const platform = process.platform;

		let skipping = false;
		this.frameCaptureTimer = setInterval(async () => {
			if (!this.frameCaptureActive || skipping) return;
			skipping = true;

			// All platforms: CLI screenshot → temp file → POST → delete
			const tmpPath = path.join(os.tmpdir(), `elizaos-frame-${Date.now()}.jpg`);
			try {
				let proc: ReturnType<typeof Bun.spawn>;

				if (platform === "darwin") {
					// -x = no shutter sound, no shadow  -t jpg = JPEG output
					proc = Bun.spawn(["screencapture", "-x", "-t", "jpg", tmpPath], {
						stdout: "ignore",
						stderr: "ignore",
					});
				} else if (platform === "win32") {
					// Windows: use PowerShell with .NET to capture the primary screen.
					// System.Windows.Forms is needed for Screen.PrimaryScreen.Bounds;
					// System.Drawing provides Bitmap and CopyFromScreen.
					const psScript = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$gfx.Dispose()
$bmp.Save('${tmpPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()`;
					proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psScript], {
						stdout: "ignore",
						stderr: "ignore",
					});
				} else {
					// Linux: try scrot first
					try {
						proc = Bun.spawn(["scrot", "--quality", String(quality), tmpPath], {
							stdout: "ignore",
							stderr: "ignore",
						});
						await proc.exited;

						if (!fs.existsSync(tmpPath)) {
							// scrot not available or failed — try ImageMagick import
							proc = Bun.spawn(["import", "-window", "root", tmpPath], {
								stdout: "ignore",
								stderr: "ignore",
							});
						}
					} catch {
						proc = Bun.spawn(["import", "-window", "root", tmpPath], {
							stdout: "ignore",
							stderr: "ignore",
						});
					}
				}

				await proc.exited;

				// macOS screencapture may append .jpg if no extension was in the path
				const actualPath = fs.existsSync(tmpPath)
					? tmpPath
					: fs.existsSync(`${tmpPath}.jpg`)
						? `${tmpPath}.jpg`
						: null;

				if (!actualPath) {
					return;
				}

				const body = fs.readFileSync(actualPath);

				fetch(endpoint, {
					method: "POST",
					headers: { "Content-Type": "image/jpeg" },
					body,
				}).catch(() => {});
			} catch {
				// Skip frame on error
			} finally {
				// Clean up temp file (handle both possible paths from screencapture)
				for (const p of [tmpPath, `${tmpPath}.jpg`]) {
					try {
						if (fs.existsSync(p)) fs.unlinkSync(p);
					} catch {
						// Ignore cleanup errors
					}
				}
				skipping = false;
			}
		}, interval);

		return { available: true };
	}

	/**
	 * Game URL capture: creates a BrowserWindow for the game URL and captures
	 * its canvas/video content via JS. Equivalent to the earlier offscreen
	 * paint-event approach (but polling, since Electrobun has no paint event).
	 */
	private async startGameCapture(
		gameUrl: string,
		_fps: number,
		quality: number,
		endpoint: string,
		interval: number,
	): Promise<{ available: boolean; reason?: string }> {
		if (!isAllowedCaptureUrl(gameUrl)) {
			return {
				available: false,
				reason: `gameUrl blocked: only localhost, 127.0.0.1, and file:// are permitted`,
			};
		}

		try {
			const win = new BrowserWindow({
				title: `${getBrandConfig().appName} Game Capture`,
				url: gameUrl,
				frame: {
					x: -9999,
					y: -9999,
					width: 1280,
					height: 720,
				},
			});

			this.frameCaptureWindow = win;

			// Capture script: grabs the first <canvas> or <video> element as JPEG
			const captureGameScript = `
        (function() {
          try {
            var el = document.querySelector('canvas') || document.querySelector('video');
            if (!el) return null;
            var c = document.createElement('canvas');
            c.width = ${1280};
            c.height = ${720};
            var ctx = c.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(el, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', ${quality / 100});
          } catch(e) { return null; }
        })()
      `;

			let skipping = false;
			this.frameCaptureTimer = setInterval(async () => {
				if (!this.frameCaptureActive || skipping) return;
				if (!this.frameCaptureWindow) {
					this.stopFrameCapture();
					return;
				}
				skipping = true;
				try {
					const captureRpc = this.frameCaptureWindow.webview
						.rpc as WebviewEvalRpc;
					const dataUrl =
						await captureRpc?.requestProxy?.evaluateJavascriptWithResponse?.({
							script: captureGameScript,
						});

					if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:"))
						return;

					const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
					const body = Buffer.from(base64, "base64");
					fetch(endpoint, {
						method: "POST",
						headers: { "Content-Type": "image/jpeg" },
						body,
					}).catch(() => {});
				} catch {
					// Skip frame
				} finally {
					skipping = false;
				}
			}, interval);

			win.on("close", () => {
				this.frameCaptureActive = false;
				this.frameCaptureWindow = null;
				if (this.frameCaptureTimer) {
					clearInterval(this.frameCaptureTimer);
					this.frameCaptureTimer = null;
				}
			});

			return { available: true };
		} catch (err) {
			this.frameCaptureActive = false;
			return {
				available: false,
				reason: `Failed to create game capture window: ${String(err)}`,
			};
		}
	}

	async stopFrameCapture(): Promise<{ available: boolean }> {
		this.frameCaptureActive = false;

		if (this.frameCaptureTimer) {
			clearInterval(this.frameCaptureTimer);
			this.frameCaptureTimer = null;
		}

		if (this.frameCaptureWindow) {
			try {
				this.frameCaptureWindow.close();
			} catch {}
			this.frameCaptureWindow = null;
		}

		return { available: true };
	}

	async isFrameCaptureActive() {
		return { active: this.frameCaptureActive };
	}

	async saveScreenshot(options: {
		data: string;
		filename?: string;
	}): Promise<{ available: boolean; path?: string }> {
		const picturesDir = path.join(os.homedir(), "Pictures");
		try {
			if (!fs.existsSync(picturesDir)) {
				fs.mkdirSync(picturesDir, { recursive: true });
			}
			const safeFilename = path.basename(options.filename ?? "");
			const ext = path.extname(safeFilename).toLowerCase();
			const allowedExts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
			const finalFilename = allowedExts.includes(ext)
				? safeFilename
				: `screenshot-${Date.now()}.jpg`;
			const filePath = path.join(picturesDir, finalFilename);
			const base64 = options.data.replace(/^data:[^;]+;base64,/, "");
			fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
			return { available: true, path: filePath };
		} catch {
			return { available: false };
		}
	}

	async switchSource(_options: {
		sourceId: string;
	}): Promise<{ available: boolean }> {
		// Restart recording with the new source (stop current, start fresh).
		// For native CLI tools, sourceId is informational only — we always
		// capture the primary display. Specific source selection requires
		// platform-level window enumeration beyond current scope.
		if (this.recordingProc) {
			await this.stopRecording();
			return this.startRecording();
		}
		// If not recording, just acknowledge the source switch
		return { available: true };
	}

	dispose(): void {
		if (this.recordingProc) {
			try {
				this.recordingProc.kill("SIGTERM");
			} catch {}
			this.recordingProc = null;
			this.recordingPath = null;
			this.recordingStart = null;
		}
		this.stopFrameCapture();
	}
}

let screenCaptureManager: ScreenCaptureManager | null = null;

export function getScreenCaptureManager(): ScreenCaptureManager {
	if (!screenCaptureManager) {
		screenCaptureManager = new ScreenCaptureManager();
	}
	return screenCaptureManager;
}
