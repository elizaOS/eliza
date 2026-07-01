/**
 * Integration coverage for the local `/api/oauth/callback` route → in-process
 * bus delivery (#8905). `plugin.test.ts` only asserts action registration; this
 * drives the REAL path end to end: the plugin's own `init` registers the real
 * `LocalOAuthCallbackBus`, a real `AWAIT_OAUTH_CALLBACK` waiter is parked via
 * `bus.waitFor`, and the real `oauthLocalCallbackRoute.handler` (the exact
 * function mounted at `POST /api/oauth/callback`) delivers the result — only the
 * HTTP req/res transport and the service-locator are thin shims.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Service } from "../../types/index.ts";
import { oauthLocalCallbackRoute, oauthPlugin } from "./plugin.ts";
import {
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	type OAuthCallbackResult,
} from "./types.ts";

/** Minimal runtime whose registerService/getService behave like the real ones
 * (start the class, index by serviceType) so the plugin registers + resolves the
 * bus exactly as it does in a live runtime. */
function makeRuntime() {
	const services = new Map<string, Service>();
	const runtime = {
		async registerService(ServiceClass: {
			serviceType: string;
			start: (rt: unknown) => Promise<Service>;
		}) {
			services.set(ServiceClass.serviceType, await ServiceClass.start(runtime));
		},
		getService<T = Service>(type: string): T | null {
			return (services.get(type) as T | undefined) ?? null;
		},
	};
	return runtime as unknown as IAgentRuntime & {
		getService<T = Service>(type: string): T | null;
	};
}

type CapturedRes = {
	statusCode: number;
	body: unknown;
	status: (code: number) => CapturedRes;
	json: (obj: unknown) => CapturedRes;
};
function makeRes(): CapturedRes {
	const res: CapturedRes = {
		statusCode: 200,
		body: undefined,
		status(code) {
			res.statusCode = code;
			return res;
		},
		json(obj) {
			res.body = obj;
			return res;
		},
	};
	return res;
}

async function bootWithLocalBus() {
	const runtime = makeRuntime();
	// Real plugin init — registers LocalOAuthCallbackBus because no cloud bus exists.
	await oauthPlugin.init?.({}, runtime);
	const bus = runtime.getService<{
		waitFor: (id: string, ms: number) => Promise<OAuthCallbackResult>;
		isWaiting: (id: string) => boolean;
	}>(OAUTH_CALLBACK_BUS_CLIENT_SERVICE);
	if (!bus) throw new Error("local bus was not registered by plugin.init");
	return { runtime, bus };
}

async function invoke(runtime: IAgentRuntime, body: Record<string, unknown>) {
	const res = makeRes();
	await oauthLocalCallbackRoute.handler(
		{ body } as never,
		res as never,
		runtime,
	);
	return res;
}

describe("oauth local /api/oauth/callback route → bus delivery (#8905)", () => {
	it("mounts as an unauthenticated POST at /api/oauth/callback", () => {
		expect(oauthLocalCallbackRoute.type).toBe("POST");
		expect(oauthLocalCallbackRoute.path).toBe("/api/oauth/callback");
		expect(oauthLocalCallbackRoute.public).toBe(true);
	});

	it("resolves a pending AWAIT waiter with the bind result", async () => {
		const { runtime, bus } = await bootWithLocalBus();
		const waitP = bus.waitFor("intent-bound", 5_000);
		expect(bus.isWaiting("intent-bound")).toBe(true);

		const res = await invoke(runtime, {
			oauthIntentId: "intent-bound",
			status: "bound",
			provider: "google",
			connectorIdentityId: "conn-123",
			scopesGranted: ["email", "profile"],
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ resolved: true });

		const result = await waitP;
		expect(result).toMatchObject({
			oauthIntentId: "intent-bound",
			status: "bound",
			provider: "google",
			connectorIdentityId: "conn-123",
			scopesGranted: ["email", "profile"],
		});
		expect(typeof result.receivedAt).toBe("number");
		expect(bus.isWaiting("intent-bound")).toBe(false);
	});

	it("delivers a denied result with its error", async () => {
		const { runtime, bus } = await bootWithLocalBus();
		const waitP = bus.waitFor("intent-denied", 5_000);
		const res = await invoke(runtime, {
			oauthIntentId: "intent-denied",
			status: "denied",
			provider: "github",
			error: "user denied access",
		});
		expect(res.statusCode).toBe(200);
		const result = await waitP;
		expect(result.status).toBe("denied");
		expect(result.error).toBe("user denied access");
	});

	it("returns 404 (resolved:false) when no waiter is pending for the intent", async () => {
		const { runtime } = await bootWithLocalBus();
		const res = await invoke(runtime, {
			oauthIntentId: "intent-nobody-waiting",
			status: "bound",
			provider: "google",
		});
		expect(res.statusCode).toBe(404);
		expect(res.body).toEqual({ resolved: false });
	});

	it("rejects a missing oauthIntentId with 400", async () => {
		const { runtime } = await bootWithLocalBus();
		const res = await invoke(runtime, { status: "bound" });
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatchObject({ resolved: false });
	});

	it("rejects an invalid/spoofed status with 400 (only bound/denied/expired)", async () => {
		const { runtime, bus } = await bootWithLocalBus();
		const waitP = bus.waitFor("intent-x", 5_000);
		for (const status of ["hacked", "", "authorized", undefined]) {
			const res = await invoke(runtime, {
				oauthIntentId: "intent-x",
				status,
			});
			expect(res.statusCode).toBe(400);
		}
		// The waiter must NOT have been resolved by any of the rejected calls.
		expect(bus.isWaiting("intent-x")).toBe(true);
		// Clean up the still-pending waiter so vitest doesn't hang.
		await invoke(runtime, { oauthIntentId: "intent-x", status: "expired" });
		await waitP;
	});

	it("drops an unknown provider rather than trusting it", async () => {
		const { runtime, bus } = await bootWithLocalBus();
		const waitP = bus.waitFor("intent-prov", 5_000);
		const res = await invoke(runtime, {
			oauthIntentId: "intent-prov",
			status: "bound",
			provider: "evil-corp",
		});
		expect(res.statusCode).toBe(200);
		const result = await waitP;
		// Only registry providers are carried through; a bogus one becomes undefined.
		expect(result.provider).toBeUndefined();
	});

	it("returns 503 when the local bus is unavailable (no cloud, no local)", async () => {
		// A runtime with NO oauth bus registered (plugin.init not run).
		const runtime = makeRuntime();
		const res = await invoke(runtime, {
			oauthIntentId: "intent-none",
			status: "bound",
			provider: "google",
		});
		expect(res.statusCode).toBe(503);
		expect(res.body).toMatchObject({ resolved: false });
	});

	it("times out a waiter that is never delivered (does not hang)", async () => {
		const { bus } = await bootWithLocalBus();
		const result = await bus.waitFor("intent-timeout", 10);
		expect(result.status).toBe("expired");
		expect(result.error).toMatch(/timed out/);
	});
});
