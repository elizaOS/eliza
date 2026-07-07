/**
 * Egress test for the PII pseudonymization layer (#10469 / #7007).
 *
 * Proves the EXECUTION boundary restores real named-entity PII into handler
 * args: the model only ever saw a surrogate, the surrogate flows verbatim into
 * the tool-call arg, and `executePlannedToolCall` swaps the REAL value back in
 * just before `action.handler` runs — so the connector call (and the REPLY
 * shown to the user) carries the real recipient while the model/trajectory kept
 * the surrogate.
 */
import { describe, expect, it, vi } from "vitest";
import {
	GazetteerEntityRecognizer,
	PseudonymSession,
} from "../../security/index.js";
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

/** An action whose handler records the args it actually received. */
function makeSendEmailAction(received: {
	to?: unknown;
	body?: unknown;
}): Action {
	return {
		name: "SEND_EMAIL",
		description: "Send an email",
		parameters: [
			{
				name: "to",
				description: "recipient",
				required: true,
				schema: { type: "string" },
			},
			{
				name: "body",
				description: "body",
				required: true,
				schema: { type: "string" },
			},
		],
		validate: async () => true,
		handler: async (_rt, _msg, _state, options) => {
			received.to = options?.parameters?.to;
			received.body = options?.parameters?.body;
			return { success: true };
		},
	} as Action;
}

/** A turn session over a known contact roster, exactly as the ingress mints one. */
function sessionWithContacts(): PseudonymSession {
	return new PseudonymSession({
		salt: "fixed",
		recognizer: new GazetteerEntityRecognizer([
			{ kind: "person", value: "Dana Whitfield" },
			{ kind: "org", value: "Acme Robotics" },
		]),
	});
}

describe("PII swap egress at executePlannedToolCall", () => {
	it("restores the REAL entities into handler args at the execution boundary", async () => {
		const received: { to?: unknown; body?: unknown } = {};
		const runtime = makeRuntime([makeSendEmailAction(received)]);
		const session = sessionWithContacts();
		await session.learn("Dana Whitfield works at Acme Robotics");
		const dana = session.entries.find((e) => e.value === "Dana Whitfield")
			?.surrogate as string;
		const acme = session.entries.find((e) => e.value === "Acme Robotics")
			?.surrogate as string;

		await runWithTrajectoryContext(
			{ runId: "run-1", piiSwapSession: session },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					// The model emitted SURROGATES in the tool-call args.
					{
						name: "SEND_EMAIL",
						params: { to: dana, body: `Hi from ${acme}` },
					},
				),
		);

		// The connector runs with the REAL recipient + org, not surrogates.
		expect(received.to).toBe("Dana Whitfield");
		expect(received.body).toBe("Hi from Acme Robotics");
	});

	it("passes brand-new names the model invented through unchanged (best-effort restore)", async () => {
		const received: { to?: unknown; body?: unknown } = {};
		const runtime = makeRuntime([makeSendEmailAction(received)]);
		const session = sessionWithContacts();
		await session.learn("Dana Whitfield");

		const result = await runWithTrajectoryContext(
			{ runId: "run-2", piiSwapSession: session },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					// A name the model produced that is not a surrogate — must not throw.
					{ name: "SEND_EMAIL", params: { to: "Someone New", body: "hi" } },
				),
		);

		expect(result.success).toBe(true);
		expect(received.to).toBe("Someone New");
	});

	it("is a no-op when PII swap is disabled (no session on the turn context)", async () => {
		const received: { to?: unknown; body?: unknown } = {};
		const runtime = makeRuntime([makeSendEmailAction(received)]);

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "SEND_EMAIL", params: { to: "plain@example.com", body: "hi" } },
		);

		expect(result.success).toBe(true);
		expect(received.to).toBe("plain@example.com");
	});
});
