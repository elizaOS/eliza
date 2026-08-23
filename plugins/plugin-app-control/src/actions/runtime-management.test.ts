/** Semantic action coverage for owner-gated Devices & Runtimes operations. */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeManagementAction,
	parseRuntimeManagementRequest,
	type RuntimeManagementFn,
} from "./runtime-management.ts";

const runtime = {} as IAgentRuntime;
const message = { content: { text: "manage my runtimes" } } as Memory;

function callback(): HandlerCallback {
	return vi.fn(async () => []) as unknown as HandlerCallback;
}

describe("RUNTIMES action", () => {
	it("is owner-gated and exposes no secret parameter", () => {
		const action = createRuntimeManagementAction();
		expect(action.roleGate).toEqual({ minRole: "OWNER" });
		expect(action.parameters?.map((parameter) => parameter.name)).not.toContain(
			"accessToken",
		);
		expect(action.parameters?.map((parameter) => parameter.name)).not.toContain(
			"privateKey",
		);
	});

	it("rejects secret-bearing action options instead of silently discarding them", () => {
		expect(
			parseRuntimeManagementRequest({
				op: "connect_ssh",
				runtimeId: "vps-1",
				target: "user@host",
				sshPort: 22,
				remoteApiPort: 2138,
				expectedFingerprint: "SHA256:verified",
				identityFile: "/Users/me/.ssh/id_ed25519",
				accessToken: "must-not-cross-the-action",
			}),
		).toBeNull();
		expect(
			parseRuntimeManagementRequest({ op: "list", access_token: "secret" }),
		).toBeNull();
	});

	it("does not dispatch a mutation without explicit confirmation", async () => {
		const manageRuntime: RuntimeManagementFn = vi.fn(async (request) => ({
			ok: true,
			op: request.op,
		}));
		const action = createRuntimeManagementAction({ manageRuntime });
		const result = await action.handler(
			runtime,
			message,
			undefined,
			{ op: "revoke", targetId: "host:mac" },
			callback(),
		);
		expect(result?.success).toBe(false);
		expect(result?.values).toEqual(
			expect.objectContaining({ awaitingConfirmation: true }),
		);
		expect(manageRuntime).not.toHaveBeenCalled();
	});

	it("does not trust a model-authored confirm flag absent user confirmation", async () => {
		const manageRuntime: RuntimeManagementFn = vi.fn(async (request) => ({
			ok: true,
			op: request.op,
		}));
		const action = createRuntimeManagementAction({ manageRuntime });
		const result = await action.handler(
			runtime,
			message,
			undefined,
			{ op: "revoke", targetId: "host:mac", confirm: "true" },
			callback(),
		);
		expect(result?.values).toEqual(
			expect.objectContaining({ awaitingConfirmation: true }),
		);
		expect(manageRuntime).not.toHaveBeenCalled();
	});

	it.each([
		"Can you confirm the runtime status?",
		"I don't confirm removing it.",
		"No, do not proceed.",
	])("rejects non-authorizing confirmation language: %s", async (text) => {
		const manageRuntime = vi.fn();
		const action = createRuntimeManagementAction({ manageRuntime });
		const result = await action.handler(
			runtime,
			{ content: { text } } as Memory,
			undefined,
			{
				op: "remove",
				runtimeId: "runtime-1",
				confirm: "yes",
			},
		);

		expect(result?.success).toBe(false);
		expect(manageRuntime).not.toHaveBeenCalled();
	});

	it("dispatches a confirmed pairing and narrates the one-use receipt", async () => {
		const manageRuntime: RuntimeManagementFn = vi.fn(async (request) => ({
			ok: true,
			op: request.op,
			data: {
				receipt: {
					sessionId: "session-1",
					code: "123456",
					expiresAt: "2026-08-23T08:00:00.000Z",
				},
			},
		}));
		const action = createRuntimeManagementAction({ manageRuntime });
		const result = await action.handler(
			runtime,
			{ content: { text: "Yes, confirm pairing" } } as Memory,
			undefined,
			{ op: "pair", targetId: "host:mac", confirm: "true" },
			callback(),
		);
		expect(manageRuntime).toHaveBeenCalledWith({
			op: "pair",
			targetId: "host:mac",
			runtimeId: undefined,
			label: undefined,
			target: undefined,
			sshPort: undefined,
			remoteApiPort: undefined,
			expectedFingerprint: undefined,
			identityFile: undefined,
			apiBase: undefined,
			sessionId: undefined,
			code: undefined,
		});
		expect(result?.success).toBe(true);
		expect(result?.text).toContain("123456");
	});

	it("returns every saved runtime in model-visible text and structured data", async () => {
		const runtimes = [
			{ id: "local", label: "This Mac", kind: "local", active: true },
			{ id: "vps", label: "Home VPS", connectionMode: "ssh", active: false },
		];
		const action = createRuntimeManagementAction({
			manageRuntime: vi.fn(async () => ({
				ok: true,
				op: "list",
				data: { runtimes },
			})),
		});
		const result = await action.handler(
			runtime,
			message,
			undefined,
			{ op: "list" },
			callback(),
		);
		expect(result?.text).toContain("This Mac (local)");
		expect(result?.text).toContain("Home VPS (vps)");
		expect(JSON.parse(String(result?.values?.resultJson))).toEqual({
			runtimes,
		});
	});

	it("allows read-only SSH inspection without a mutation confirmation", async () => {
		const manageRuntime: RuntimeManagementFn = vi.fn(async () => ({
			ok: true,
			op: "inspect_ssh",
			data: {
				inspection: {
					fingerprints: [
						{ algorithm: "ssh-ed25519", fingerprint: "SHA256:observed" },
					],
					preferredFingerprint: "SHA256:observed",
				},
			},
		}));
		const action = createRuntimeManagementAction({ manageRuntime });
		const result = await action.handler(
			runtime,
			message,
			undefined,
			{ op: "inspect_ssh", target: "user@host", sshPort: 22 },
			callback(),
		);
		expect(result?.success).toBe(true);
		expect(result?.text).toContain("ssh-ed25519: SHA256:observed");
		expect(result?.text).toContain("Preferred fingerprint: SHA256:observed");
		expect(manageRuntime).toHaveBeenCalledTimes(1);
	});

	it("binds the default HTTP handoff to the originating renderer", async () => {
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ ok: true, op: "list", data: { runtimes: [] } }),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const action = createRuntimeManagementAction();
			const result = await action.handler(
				runtime,
				{
					content: {
						text: "list my runtimes",
						metadata: { viewClientId: "origin-renderer" },
					},
				} as Memory,
				undefined,
				{ op: "list" },
				callback(),
			);
			expect(result?.success).toBe(true);
			const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(body).toEqual({ op: "list", clientId: "origin-renderer" });
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("refuses an unbound mutation instead of racing arbitrary connected shells", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		try {
			const action = createRuntimeManagementAction();
			const result = await action.handler(
				runtime,
				{ content: { text: "Yes, confirm removing it" } } as Memory,
				undefined,
				{ op: "remove", runtimeId: "vps-1", confirm: "true" },
				callback(),
			);
			expect(result?.success).toBe(false);
			expect(result?.text).toContain("bound to that device");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
