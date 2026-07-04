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
import { SecretSwapSession } from "../../security/secret-swap";
import { runWithTrajectoryContext } from "../../trajectory-context";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { executePlannedToolCall } from "../execute-planned-tool-call";

function makeRuntime(actions: Action[]): IAgentRuntime {
	return {
		actions,
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
});
