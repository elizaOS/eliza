import crypto from "node:crypto";
import http from "node:http";
import { getBrowserWorkspaceManager } from "./native/browser-workspace";
import type { BrowserWorkspaceEventType } from "./native/browser-workspace";
import { findFirstAvailableLoopbackPort } from "./native/loopback-port";

const DEFAULT_BRIDGE_PORT = 31_340;
const MAX_BODY_BYTES = 1024 * 1024;

type BrowserWorkspaceCreateBody = {
	url?: string;
	title?: string;
	show?: boolean;
	partition?: string;
	connectorProvider?: string;
	connectorAccountId?: string;
	kind?: "internal" | "standard";
	width?: number;
	height?: number;
};

type BrowserWorkspaceAcquireSessionBody = {
	provider?: string;
	accountId?: string;
	url?: string;
	title?: string;
	show?: boolean;
	reuse?: boolean;
	authState?:
		| "unknown"
		| "ready"
		| "auth_pending"
		| "needs_reauth"
		| "manual_handoff";
	manualHandoffReason?: string | null;
};

type BrowserWorkspaceNavigateBody = {
	url?: string;
};

type BrowserWorkspaceEvalBody = {
	script?: string;
};

const BROWSER_WORKSPACE_EVENT_TYPES = new Set<BrowserWorkspaceEventType>([
	"open",
	"navigate",
	"show",
	"hide",
	"close",
	"eval.start",
	"eval.end",
	"eval.error",
	"snapshot.success",
	"snapshot.miss",
]);

function isLoopback(addr: string | undefined): boolean {
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function scrubStack(value: unknown): unknown {
	if (value instanceof Error)
		return { error: value.message || "Internal error" };
	if (Array.isArray(value)) return value.map(scrubStack);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (k === "stack" || k === "stackTrace") continue;
			out[k] = scrubStack(v);
		}
		return out;
	}
	return value;
}

function json(
	res: http.ServerResponse,
	status: number,
	body: Record<string, unknown>,
): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(scrubStack(body)));
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
	// Always require a non-empty token. The caller generates a random token at
	// startup, so an empty token here indicates a misconfiguration — reject.
	if (!token) return false;
	return req.headers.authorization === `Bearer ${token}`;
}

function normalizeTabId(raw: string): string {
	return decodeURIComponent(raw).trim();
}

function readIntegerSearchParam(url: URL, key: string): number | undefined {
	const raw = url.searchParams.get(key)?.trim();
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function readBrowserWorkspaceEventType(
	url: URL,
): BrowserWorkspaceEventType | undefined {
	const raw = url.searchParams.get("type")?.trim();
	if (!raw) return undefined;
	return BROWSER_WORKSPACE_EVENT_TYPES.has(raw as BrowserWorkspaceEventType)
		? (raw as BrowserWorkspaceEventType)
		: undefined;
}

export async function startBrowserWorkspaceBridgeServer(): Promise<() => void> {
	const requestedPort =
		Number.parseInt(
			(process.env.ELIZA_BROWSER_WORKSPACE_PORT ?? "").trim(),
			10,
		) || DEFAULT_BRIDGE_PORT;
	const port = await findFirstAvailableLoopbackPort(requestedPort, {
		host: "127.0.0.1",
		maxHops: 32,
	});
	const token =
		(process.env.ELIZA_BROWSER_WORKSPACE_TOKEN ?? "").trim() ||
		crypto.randomBytes(18).toString("hex");
	const baseUrl = `http://127.0.0.1:${port}`;
	const manager = getBrowserWorkspaceManager();

	process.env.ELIZA_BROWSER_WORKSPACE_URL = baseUrl;
	process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = token;

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
				const { tabs } = await manager.listTabs();
				json(res, 200, { ok: true, tabCount: tabs.length });
				return;
			}

			if (pathname === "/tabs" && method === "GET") {
				json(res, 200, await manager.listTabs());
				return;
			}

			if (pathname === "/events" && method === "GET") {
				const eventLog = await manager.listEvents({
					after: readIntegerSearchParam(url, "after"),
					limit: readIntegerSearchParam(url, "limit"),
					tabId: url.searchParams.get("tabId") ?? undefined,
					type: readBrowserWorkspaceEventType(url),
				});
				json(res, 200, { ...eventLog });
				return;
			}

			if (pathname === "/tabs" && method === "POST") {
				const body =
					(await readJsonBody<BrowserWorkspaceCreateBody>(req)) ?? {};
				json(res, 200, {
					tab: await manager.openTab({
						url: body.url,
						title: body.title,
						show: body.show,
						partition: body.partition,
						connectorProvider: body.connectorProvider,
						connectorAccountId: body.connectorAccountId,
						kind: body.kind,
						width: body.width,
						height: body.height,
					}),
				});
				return;
			}

			if (pathname === "/sessions/acquire" && method === "POST") {
				const body =
					(await readJsonBody<BrowserWorkspaceAcquireSessionBody>(req)) ?? {};
				if (!body.provider?.trim() || !body.accountId?.trim()) {
					json(res, 400, { error: "provider and accountId are required" });
					return;
				}
				json(res, 200, {
					session: await manager.acquireConnectorSession({
						provider: body.provider,
						accountId: body.accountId,
						url: body.url,
						title: body.title,
						show: body.show,
						reuse: body.reuse,
						authState: body.authState,
						manualHandoffReason: body.manualHandoffReason,
					}),
				});
				return;
			}

			const match = pathname.match(
				/^\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/,
			);
			if (!match) {
				json(res, 404, { error: "not found" });
				return;
			}

			const tabId = normalizeTabId(match[1]);
			const action = match[2] ?? null;

			if (!action && method === "DELETE") {
				const closed = await manager.closeTab({ id: tabId });
				json(res, closed ? 200 : 404, { closed });
				return;
			}

			if (action === "snapshot" && method === "GET") {
				const snapshot = await manager.snapshotTab({ id: tabId });
				if (!snapshot) {
					json(res, 409, { error: "snapshot unavailable" });
					return;
				}
				json(res, 200, snapshot);
				return;
			}

			if (action === "show" && method === "POST") {
				const tab = await manager.showTab({ id: tabId });
				json(res, tab ? 200 : 404, tab ? { tab } : { error: "tab not found" });
				return;
			}

			if (action === "hide" && method === "POST") {
				const tab = await manager.hideTab({ id: tabId });
				json(res, tab ? 200 : 404, tab ? { tab } : { error: "tab not found" });
				return;
			}

			if (action === "navigate" && method === "POST") {
				const body = await readJsonBody<BrowserWorkspaceNavigateBody>(req);
				if (!body?.url) {
					json(res, 400, { error: "url is required" });
					return;
				}
				const tab = await manager.navigateTab({ id: tabId, url: body.url });
				json(res, tab ? 200 : 404, tab ? { tab } : { error: "tab not found" });
				return;
			}

			if (action === "eval" && method === "POST") {
				const body = await readJsonBody<BrowserWorkspaceEvalBody>(req);
				if (!body?.script?.trim()) {
					json(res, 400, { error: "script is required" });
					return;
				}
				try {
					json(res, 200, {
						result: await manager.evaluateTab({
							id: tabId,
							script: body.script,
						}),
					});
				} catch (error) {
					json(res, 404, {
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}

			json(res, 405, { error: "method not allowed" });
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

	console.log(
		`[BrowserWorkspaceBridge] ${baseUrl} (loopback only; token required)`,
	);

	return () => {
		server.close();
	};
}
