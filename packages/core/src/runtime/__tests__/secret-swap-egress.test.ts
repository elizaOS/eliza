/**
 * End-to-end egress test for the secret-swap layer (#10469).
 *
 * Proves the EXECUTION boundary restores real secrets into the handler args:
 * the model only ever saw a placeholder, the placeholder flows verbatim into the
 * tool-call arg, and `executePlannedToolCall` swaps the REAL value back in just
 * before `action.handler` runs — while a fabricated placeholder fails loud
 * instead of reaching the handler. The session is carried on the turn-scoped
 * trajectory context exactly as `useModel` stores it on ingress.
 */
import { describe, expect, it, vi } from "vitest";
import {
	MAX_SECRET_SWAP_WALK_NODES,
	SecretSwapSession,
} from "../../security/secret-swap";
import { runWithTrajectoryContext } from "../../trajectory-context";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { executePlannedToolCall } from "../execute-planned-tool-call";

function makeRuntime(actions: Action[]): IAgentRuntime {
	return {
		actions,
		getRoom: vi.fn(async () => null),
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

/** An action whose handler records the `token` argument it actually received. */
function makeWebhookAction(received: { token?: unknown }): Action {
	return {
		name: "CALL_WEBHOOK",
		description: "Call a webhook with a secret token",
		parameters: [
			{
				name: "token",
				description: "Auth token",
				required: true,
				schema: { type: "string" },
			},
		],
		validate: async () => true,
		handler: async (_rt, _msg, _state, options) => {
			received.token = options?.parameters?.token;
			return { success: true };
		},
	} as Action;
}

const SECRET = "whsec_realsecretvalue1234567890";

/** Mint a session + the placeholder it assigns to SECRET, like ingress would.
 * The secret is seeded as a known character secret (the realistic path). */
function sessionWithSecret(): {
	session: SecretSwapSession;
	placeholder: string;
} {
	const session = new SecretSwapSession({
		knownSecrets: { WEBHOOK_SECRET: SECRET },
	});
	const swapped = session.substituteText(`webhook ${SECRET}`);
	const placeholder = swapped.match(
		/__ELIZA_SECRET_[0-9a-f]+_\d+__/,
	)?.[0] as string;
	return { session, placeholder };
}

describe("secret-swap egress at executePlannedToolCall", () => {
	it("restores the REAL secret into handler args only at the execution boundary", async () => {
		const received: { token?: unknown } = {};
		const runtime = makeRuntime([makeWebhookAction(received)]);
		const { session, placeholder } = sessionWithSecret();

		const result = await runWithTrajectoryContext(
			{ runId: "run-1", secretSwapSession: session },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					// The model emitted the PLACEHOLDER in the tool-call arg.
					{ name: "CALL_WEBHOOK", params: { token: placeholder } },
				),
		);

		expect(result.success).toBe(true);
		// The handler executed with the REAL secret, not the placeholder.
		expect(received.token).toBe(SECRET);
	});

	it("fails loud (no handler run) when the model fabricated an unresolved placeholder", async () => {
		const received: { token?: unknown } = {};
		const handler = vi.fn(makeWebhookAction(received).handler);
		const runtime = makeRuntime([
			{ ...makeWebhookAction(received), handler } as Action,
		]);
		const { session, placeholder } = sessionWithSecret();
		const nonce = placeholder.match(/__ELIZA_SECRET_([0-9a-f]+)_\d+__/)?.[1];

		const result = await runWithTrajectoryContext(
			{ runId: "run-2", secretSwapSession: session },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					// A this-turn placeholder the layer never minted (fabricated N).
					{
						name: "CALL_WEBHOOK",
						params: { token: `__ELIZA_SECRET_${nonce}_999__` },
					},
				),
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unresolved secret placeholder");
		expect(handler).not.toHaveBeenCalled();
	});

	it("is a no-op when secret-swap is disabled (no session on the turn context)", async () => {
		const received: { token?: unknown } = {};
		const runtime = makeRuntime([makeWebhookAction(received)]);

		// No trajectory context / no session — the arg passes through untouched.
		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "CALL_WEBHOOK", params: { token: "plain-non-secret-token" } },
		);

		expect(result.success).toBe(true);
		expect(received.token).toBe("plain-non-secret-token");
	});

	it("rejects an unbounded action graph before handler dispatch", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = {
			name: "PROCESS_PAYLOAD",
			description: "Process a structured payload",
			parameters: [
				{
					name: "payload",
					description: "Payload values",
					required: true,
					schema: { type: "array" },
				},
			],
			validate: async () => true,
			handler,
		} as Action;
		const session = new SecretSwapSession();

		const result = await runWithTrajectoryContext(
			{ runId: "run-unbounded", secretSwapSession: session },
			() =>
				executePlannedToolCall(
					makeRuntime([action]),
					{ message: makeMessage() },
					{
						name: action.name,
						params: { payload: new Array(MAX_SECRET_SWAP_WALK_NODES) },
					},
				),
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("walk budget");
		expect(handler).not.toHaveBeenCalled();
	});

	it("restores placeholders in non-standard records before action dispatch", async () => {
		const { session, placeholder } = sessionWithSecret();
		class Payload {
			token = placeholder;
		}
		const records = [
			Object.assign(Object.create(null), { token: placeholder }),
			new Payload(),
			Object.assign(Object.create({ inherited: placeholder }), {
				token: placeholder,
			}),
		];

		for (const [index, payload] of records.entries()) {
			const received: { token?: unknown } = {};
			const action = {
				...makeWebhookAction(received),
				parameters: [
					{
						name: "payload",
						description: "Structured secret-bearing payload",
						required: true,
						schema: { type: "object", additionalProperties: true },
					},
				],
				handler: vi.fn(async (_rt, _msg, _state, options) => {
					const restoredPayload = options?.parameters?.payload;
					if (restoredPayload && typeof restoredPayload === "object") {
						received.token = (restoredPayload as Record<string, unknown>).token;
					}
					return { success: true };
				}),
			} as Action;
			const result = await runWithTrajectoryContext(
				{ runId: `run-record-${index}`, secretSwapSession: session },
				() =>
					executePlannedToolCall(
						makeRuntime([action]),
						{ message: makeMessage() },
						{ name: action.name, params: { payload } },
					),
			);
			expect(result.success, JSON.stringify(result)).toBe(true);
			expect(received.token).toBe(SECRET);
			expect(action.handler).toHaveBeenCalledTimes(1);
		}
	});
});
