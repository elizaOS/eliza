import crypto from "node:crypto";
import http from "node:http";
import { invokeApplicationMenuAction } from "./application-menu-action-registry";
import {
	evaluateInCurrentMainWindow,
	getCurrentMainWindowSnapshot,
} from "./main-window-runtime";
import { getDesktopManager } from "./native/desktop";
import { findFirstAvailableLoopbackPort } from "./native/loopback-port";
import { getScreenCaptureManager } from "./native/screencapture";
import type { WindowBounds } from "./rpc-schema";

const DEFAULT_TEST_BRIDGE_PORT = 31_341;
const MAX_BODY_BYTES = 1024 * 1024;

type EvalBody = {
	script?: string;
};

type BoundsBody = Partial<WindowBounds>;

type MenuActionBody = {
	action?: string;
};

function isLoopback(addr: string | undefined): boolean {
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function json(
	res: http.ServerResponse,
	status: number,
	body: Record<string, unknown>,
): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new Error("request body too large");
		}
		chunks.push(buffer);
	}

	if (chunks.length === 0) {
		return null;
	}

	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
	if (!token) return false;
	return req.headers.authorization === `Bearer ${token}`;
}

function isTruthyEnv(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function pickFiniteNumber(
	value: unknown,
	fallback: number,
	options: { min?: number } = {},
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	if (typeof options.min === "number" && value < options.min) {
		return fallback;
	}
	return value;
}

export async function startDesktopTestBridgeServer(): Promise<
	(() => void) | undefined
> {
	if (
		!isTruthyEnv(process.env.ELIZA_DESKTOP_TEST_BRIDGE_ENABLED) &&
		!process.env.ELIZA_DESKTOP_TEST_BRIDGE_PORT &&
		!process.env.ELIZA_DESKTOP_TEST_BRIDGE_TOKEN
	) {
		return undefined;
	}

	const requestedPort =
		Number.parseInt(
			(process.env.ELIZA_DESKTOP_TEST_BRIDGE_PORT ?? "").trim(),
			10,
		) || DEFAULT_TEST_BRIDGE_PORT;
	const port = await findFirstAvailableLoopbackPort(requestedPort, {
		host: "127.0.0.1",
		maxHops: 32,
	});
	const token =
		process.env.ELIZA_DESKTOP_TEST_BRIDGE_TOKEN?.trim() ||
		crypto.randomBytes(18).toString("hex");
	const baseUrl = `http://127.0.0.1:${port}`;

	process.env.ELIZA_DESKTOP_TEST_BRIDGE_URL = baseUrl;
	process.env.ELIZA_DESKTOP_TEST_BRIDGE_TOKEN = token;

	const server = http.createServer(async (req, res) => {
		try {
			if (!isLoopback(req.socket.remoteAddress)) {
				json(res, 403, { error: "forbidden" });
				return;
			}
			if (!isAuthorized(req, token)) {
				json(res, 401, { error: "unauthorized" });
				return;
			}

			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const pathname = url.pathname;
			const method = req.method ?? "GET";

			if (pathname === "/health" && method === "GET") {
				json(res, 200, { ok: true });
				return;
			}

			if (pathname === "/state" && method === "GET") {
				const shellState = await getDesktopManager().getShellDiagnosticsState();
				json(res, 200, {
					mainWindow: getCurrentMainWindowSnapshot(),
					shell: shellState,
				});
				return;
			}

			if (pathname === "/main-window/eval" && method === "POST") {
				const body = await readJsonBody<EvalBody>(req);
				if (!body?.script?.trim()) {
					json(res, 400, { error: "script is required" });
					return;
				}
				json(res, 200, {
					result: await evaluateInCurrentMainWindow(body.script),
				});
				return;
			}

			if (pathname === "/main-window/close" && method === "POST") {
				const desktop = getDesktopManager();
				const shellState = await desktop.getShellDiagnosticsState();
				if (!shellState.mainWindowPresent) {
					json(res, 503, { error: "main window is not available" });
					return;
				}
				await desktop.closeWindow();
				json(res, 200, { ok: true });
				return;
			}

			if (pathname === "/main-window/bounds") {
				const snapshot = getCurrentMainWindowSnapshot();
				if (!snapshot.present) {
					json(res, 503, { error: "main window is not available" });
					return;
				}

				const desktop = getDesktopManager();
				const currentBounds = await desktop.getWindowBounds();

				if (method === "GET") {
					json(res, 200, { bounds: currentBounds });
					return;
				}

				if (method === "POST") {
					const body = (await readJsonBody<BoundsBody>(req)) ?? {};
					const nextBounds: WindowBounds = {
						x: pickFiniteNumber(body.x, currentBounds.x),
						y: pickFiniteNumber(body.y, currentBounds.y),
						width: pickFiniteNumber(body.width, currentBounds.width, {
							min: 1,
						}),
						height: pickFiniteNumber(body.height, currentBounds.height, {
							min: 1,
						}),
					};
					await desktop.setWindowBounds(nextBounds);
					json(res, 200, {
						bounds: await desktop.getWindowBounds(),
					});
					return;
				}
			}

			if (pathname === "/main-window/screenshot" && method === "GET") {
				const shot = await getScreenCaptureManager().takeScreenshot();
				if (!shot.available || !shot.data) {
					json(res, 503, { error: "screenshot unavailable" });
					return;
				}
				json(res, 200, { data: shot.data });
				return;
			}

			if (pathname === "/menu-action" && method === "POST") {
				const body = await readJsonBody<MenuActionBody>(req);
				const action = body?.action?.trim();
				if (!action) {
					json(res, 400, { error: "action is required" });
					return;
				}
				const invoked = await invokeApplicationMenuAction(action);
				json(
					res,
					invoked ? 200 : 503,
					invoked
						? { ok: true }
						: { error: "application menu handler unavailable" },
				);
				return;
			}

			json(res, 404, { error: "not found" });
		} catch (error) {
			json(res, 500, {
				error: error instanceof Error ? error.message : "internal error",
			});
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	console.log(`[DesktopTestBridge] ${baseUrl} (loopback only; token required)`);

	return () => {
		server.close();
	};
}
