/**
 * Dev-only localhost server so tools can fetch a PNG without talking to WKWebView APIs.
 *
 * **Why separate HTTP in Electrobun:** the the app API process cannot capture the desktop; capture
 * runs in the shell process via ScreenCaptureManager → OS tools (e.g. macOS `screencapture`).
 *
 * **Why full screen (for now):** reuses battle-tested `takeScreenshot()`; window-ID capture is
 * platform-specific and not wired here yet.
 *
 * **Why loopback + optional token:** reduces accidental exposure on shared machines; dev-platform
 * generates a session token and the API proxy adds a single URL on the familiar API port.
 *
 * Enable with ELIZA_DESKTOP_SCREENSHOT_SERVER=`1` / `true` / `yes` (dev-platform sets `1` by default
 * for `dev:desktop:*`). Port: ELIZA_SCREENSHOT_SERVER_PORT (default 31339). Auth: ELIZA_SCREENSHOT_SERVER_TOKEN
 * as Bearer header only (query params not supported to avoid token leakage in logs/Referer).
 */

import http from "node:http";
import { getScreenCaptureManager } from "./native/screencapture";

function isLoopback(addr: string | undefined): boolean {
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * @returns Cleanup to close the server, or `undefined` when disabled.
 */
export function startScreenshotDevServer(): (() => void) | undefined {
	const raw = process.env.ELIZA_DESKTOP_SCREENSHOT_SERVER?.trim().toLowerCase();
	const enabled = raw === "1" || raw === "true" || raw === "yes";
	if (!enabled) {
		return undefined;
	}

	const port = Number(process.env.ELIZA_SCREENSHOT_SERVER_PORT) || 31339;
	const token = process.env.ELIZA_SCREENSHOT_SERVER_TOKEN?.trim() ?? "";

	const server = http.createServer(async (req, res) => {
		try {
			if (!isLoopback(req.socket.remoteAddress)) {
				res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("forbidden");
				return;
			}
			if (req.method !== "GET") {
				res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("method not allowed");
				return;
			}

			const u = new URL(req.url ?? "/", "http://127.0.0.1");
			if (u.pathname !== "/cursor-screenshot.png") {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("not found");
				return;
			}

			if (token) {
				// Bearer-only — query param `?token=` intentionally not supported
				// to avoid token leakage in server logs and Referer headers.
				const auth = req.headers.authorization;
				if (auth !== `Bearer ${token}`) {
					res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("unauthorized");
					return;
				}
			}

			const shot = await getScreenCaptureManager().takeScreenshot();
			if (!shot.available || !shot.data) {
				res.writeHead(503, {
					"Content-Type": "application/json; charset=utf-8",
				});
				res.end(
					JSON.stringify({ error: "screen capture failed or unavailable" }),
				);
				return;
			}

			const prefix = "data:image/png;base64,";
			const b64 = shot.data.startsWith(prefix)
				? shot.data.slice(prefix.length)
				: shot.data.replace(/^data:[^;]+;base64,/, "");
			const buf = Buffer.from(b64, "base64");
			res.writeHead(200, {
				"Content-Type": "image/png",
				"Cache-Control": "no-store",
			});
			res.end(buf);
		} catch {
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			}
			res.end("error");
		}
	});

	if (!token) {
		console.warn(
			"[ScreenshotDev] No ELIZA_SCREENSHOT_SERVER_TOKEN set — screenshot endpoint is unprotected on loopback",
		);
	}

	server.on("error", (err: NodeJS.ErrnoException) => {
		const inUse = err.code === "EADDRINUSE";
		console.warn(
			`[ScreenshotDev] Failed to start loopback server on 127.0.0.1:${port}: ${err.message}` +
				(inUse
					? " (port in use — set ELIZA_SCREENSHOT_SERVER_PORT to a free port or stop the other process)"
					: ""),
		);
	});

	server.listen(port, "127.0.0.1", () => {
		console.log(
			`[ScreenshotDev] http://127.0.0.1:${port}/cursor-screenshot.png (loopback only` +
				(token ? "; token required" : "") +
				")",
		);
	});

	return () => {
		server.close();
	};
}
