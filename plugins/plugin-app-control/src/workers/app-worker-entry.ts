/**
 * @module plugin-app-control/workers/app-worker-entry
 *
 * Bun worker entry point spawned by AppWorkerHostService for apps that
 * declare `isolation: "worker"` in their manifest. Phase 2.2 surface:
 * a minimal typed RPC bridge that proves a round-trip can carry a
 * method invocation across the worker boundary and return a result.
 *
 * Subsequent slices (2.3+) replace the in-line `BRIDGE_METHODS` map
 * with a dynamic import of the app's plugin entry-point and a typed
 * `invokeAction(name, params)` dispatch; this slice keeps the wire
 * format small so the latency can be measured against a stable
 * baseline before the heavier plugin-loading path lands.
 *
 * Wire format (parentPort messages):
 *
 *   host -> worker:  { id, method: "ping" }                 → { id, ok: true, result: { pong: true, slug, isolation } }
 *   host -> worker:  { id, method: "echo", params }         → { id, ok: true, result: params }
 *   host -> worker:  { id, method: "shutdown" }             → exits the worker (no response)
 *   host -> worker:  { id, method: "<unknown>", params }    → { id, ok: false, reason: "unknown method" }
 *
 *   worker -> host:  { id, ok: true, result }
 *                |   { id, ok: false, reason }
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";

interface WorkerBootData {
	slug: string;
	isolation: "none" | "worker";
}

interface RpcRequest {
	id: number;
	method: string;
	params?: unknown;
}

type RpcResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; reason: string };

if (isMainThread) {
	throw new Error(
		"app-worker-entry must be loaded via new Worker(), not as a main module.",
	);
}

if (!parentPort) {
	throw new Error("app-worker-entry expects parentPort to be defined.");
}

const boot = (workerData ?? {}) as Partial<WorkerBootData>;
const slug = typeof boot.slug === "string" ? boot.slug : "unknown";
const isolation = boot.isolation === "worker" ? "worker" : "none";

type BridgeHandler = (params: unknown) => unknown | Promise<unknown>;

const BRIDGE_METHODS: Record<string, BridgeHandler> = {
	ping: () => ({ pong: true, slug, isolation }),
	echo: (params) => params,
};

async function dispatch(req: RpcRequest): Promise<RpcResponse> {
	if (req.method === "shutdown") {
		// Acknowledge via process exit; no response. Host treats the
		// "exit" event from the Worker handle as confirmation.
		process.exit(0);
	}
	const handler = BRIDGE_METHODS[req.method];
	if (!handler) {
		return {
			id: req.id,
			ok: false,
			reason: `unknown method: ${req.method}`,
		};
	}
	try {
		const result = await handler(req.params);
		return { id: req.id, ok: true, result };
	} catch (error) {
		return {
			id: req.id,
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

parentPort.on("message", (raw: unknown) => {
	if (
		typeof raw !== "object" ||
		raw === null ||
		typeof (raw as RpcRequest).id !== "number" ||
		typeof (raw as RpcRequest).method !== "string"
	) {
		return;
	}
	const req = raw as RpcRequest;
	void dispatch(req).then((response) => {
		parentPort?.postMessage(response);
	});
});

// Signal readiness so the host knows the worker is alive and the
// message handler is wired. `{id: 0}` is reserved for this boot
// notification and is never sent by the host's `invoke()`.
parentPort.postMessage({ id: 0, ok: true, result: { ready: true, slug } });
