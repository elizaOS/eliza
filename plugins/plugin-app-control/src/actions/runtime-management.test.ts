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

	it("parses only the public SSH trust material", () => {
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
		).toEqual({
			op: "connect_ssh",
			runtimeId: "vps-1",
			target: "user@host",
			sshPort: 22,
			remoteApiPort: 2138,
			expectedFingerprint: "SHA256:verified",
			identityFile: "/Users/me/.ssh/id_ed25519",
			targetId: undefined,
			label: undefined,
			apiBase: undefined,
			sessionId: undefined,
			code: undefined,
		});
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
			message,
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

	it("allows read-only SSH inspection without a mutation confirmation", async () => {
		const manageRuntime: RuntimeManagementFn = vi.fn(async () => ({
			ok: true,
			op: "inspect_ssh",
			data: { inspection: { fingerprints: ["SHA256:observed"] } },
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
		expect(manageRuntime).toHaveBeenCalledTimes(1);
	});
});
