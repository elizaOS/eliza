/**
 * Unit tests for LocalOAuthCallbackBus and the oauthLocalCallbackRoute HTTP
 * handler — the in-process rendezvous that lets an awaiting agent turn resolve
 * when a local OAuth callback lands (publish/waitFor, timeout expiry, supersede,
 * stop, and the route's 200/400/404/503 status contract). Deterministic
 * harness with fake timers and a stub response object; no real HTTP server.
 */
import { describe, expect, test, vi } from "vitest";
import type { IAgentRuntime } from "../../types/index.ts";
import { LocalOAuthCallbackBus } from "./local-callback-bus.ts";
import { oauthLocalCallbackRoute } from "./plugin.ts";

function makeBus(): LocalOAuthCallbackBus {
	return new LocalOAuthCallbackBus({ agentId: "agent-1" } as IAgentRuntime);
}

describe("LocalOAuthCallbackBus (#8905)", () => {
	test("publish resolves a pending waiter with the delivered result", async () => {
		const bus = makeBus();
		const waited = bus.waitFor("oauth_1", 5_000);
		expect(bus.isWaiting("oauth_1")).toBe(true);

		const resolved = bus.publish({
			oauthIntentId: "oauth_1",
			provider: "github",
			status: "bound",
			connectorIdentityId: "ident_42",
			scopesGranted: ["repo"],
		});
		expect(resolved).toBe(true);

		const result = await waited;
		expect(result.status).toBe("bound");
		expect(result.provider).toBe("github");
		expect(result.connectorIdentityId).toBe("ident_42");
		expect(typeof result.receivedAt).toBe("number");
		expect(bus.isWaiting("oauth_1")).toBe(false);
	});

	test("publish returns false when nothing is waiting", () => {
		const bus = makeBus();
		expect(
			bus.publish({
				oauthIntentId: "missing",
				provider: "github",
				status: "bound",
			}),
		).toBe(false);
	});

	test("waitFor resolves to expired on timeout", async () => {
		vi.useFakeTimers();
		try {
			const bus = makeBus();
			const waited = bus.waitFor("oauth_to", 1_000);
			vi.advanceTimersByTime(1_001);
			const result = await waited;
			expect(result.status).toBe("expired");
			expect(result.error).toContain("timed out");
			expect(bus.isWaiting("oauth_to")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a second wait supersedes the first (first expires)", async () => {
		const bus = makeBus();
		const first = bus.waitFor("oauth_dup", 5_000);
		bus.waitFor("oauth_dup", 5_000);
		const firstResult = await first;
		expect(firstResult.status).toBe("expired");
		expect(firstResult.error).toContain("superseded");
	});

	test("stop expires all pending waiters", async () => {
		const bus = makeBus();
		const waited = bus.waitFor("oauth_stop", 5_000);
		await bus.stop();
		const result = await waited;
		expect(result.status).toBe("expired");
		expect(bus.isWaiting("oauth_stop")).toBe(false);
	});
});

describe("oauthLocalCallbackRoute (#8905)", () => {
	function makeRes() {
		const res = {
			statusCode: 0,
			body: undefined as unknown,
			status(code: number) {
				res.statusCode = code;
				return res;
			},
			json(data: unknown) {
				res.body = data;
				return res;
			},
		};
		return res;
	}

	function runtimeWith(bus: LocalOAuthCallbackBus | null): IAgentRuntime {
		return {
			agentId: "agent-1",
			getService: () => bus,
		} as unknown as IAgentRuntime;
	}

	test("resolves the local bus by intentId and returns 200", async () => {
		const bus = makeBus();
		const waited = bus.waitFor("oauth_route", 5_000);
		const res = makeRes();
		await oauthLocalCallbackRoute.handler?.(
			{
				body: {
					oauthIntentId: "oauth_route",
					provider: "github",
					status: "bound",
					connectorIdentityId: "ident_1",
				},
			} as never,
			res as never,
			runtimeWith(bus),
		);
		expect(res.statusCode).toBe(200);
		expect(res.body).toEqual({ resolved: true });
		const result = await waited;
		expect(result.status).toBe("bound");
		expect(result.connectorIdentityId).toBe("ident_1");
	});

	test("returns 404 when no waiter is pending for the intent", async () => {
		const bus = makeBus();
		const res = makeRes();
		await oauthLocalCallbackRoute.handler?.(
			{ body: { oauthIntentId: "nobody", status: "bound" } } as never,
			res as never,
			runtimeWith(bus),
		);
		expect(res.statusCode).toBe(404);
		expect(res.body).toEqual({ resolved: false });
	});

	test("returns 400 on missing intentId or invalid status", async () => {
		const res = makeRes();
		await oauthLocalCallbackRoute.handler?.(
			{ body: { status: "bogus" } } as never,
			res as never,
			runtimeWith(makeBus()),
		);
		expect(res.statusCode).toBe(400);
	});

	test("returns 503 when no local bus is registered", async () => {
		const res = makeRes();
		await oauthLocalCallbackRoute.handler?.(
			{ body: { oauthIntentId: "x", status: "bound" } } as never,
			res as never,
			runtimeWith(null),
		);
		expect(res.statusCode).toBe(503);
	});
});
