/**
 * Exercises the real message-interaction exactly-once protocol: opaque
 * reference encoding, response-schema derivation and validation, every
 * claim/commit/complete/reconcile/revoke transition including replay and
 * stale-claim refusal, the atomic in-memory store (ordering, limits, expiry
 * sweep, concurrent claims), and the authority end-to-end lifecycle against a
 * scripted effect executor. Deterministic and mock-free — derived states are
 * produced through the real transitions, never fabricated.
 */
import { describe, expect, it } from "vitest";
import type {
	ChoiceInteraction,
	FollowupsInteraction,
	FormInteraction,
	SecretInteraction,
	TaskInteraction,
} from "../../types/interactions";
import type { ConnectorInteractionCapabilityProfile } from "./profiles";
import {
	applyMessageInteractionClaim,
	applyMessageInteractionCommit,
	applyMessageInteractionCompletion,
	applyMessageInteractionReconciliation,
	applyMessageInteractionRevocation,
	createOpaqueMessageInteractionReference,
	decodeMessageInteractionCallback,
	encodeMessageInteractionCallback,
	InMemoryMessageInteractionSessionStore,
	MESSAGE_INTERACTION_CALLBACK_BYTES,
	MESSAGE_INTERACTION_CALLBACK_PREFIX,
	type MessageInteractionAuthorizationDecision,
	type MessageInteractionBindings,
	type MessageInteractionClaimContext,
	type MessageInteractionClaimResult,
	type MessageInteractionConsumeState,
	type MessageInteractionEffectExecutor,
	type MessageInteractionReceipt,
	type MessageInteractionResponse,
	MessageInteractionSessionAuthority,
	responseSchemaForInteraction,
	validateMessageInteractionResponse,
} from "./sessions";

const NOW = 1_700_000_000_000;
const CLAIM_TTL_MS = 30_000;
const REFERENCE = "0a".repeat(16);
const CLAIM_ID = "claim-1";
const REPLAY_KEY = "replay-key-1";
const RESPONSE_A: MessageInteractionResponse = { value: "a" };
const RESPONSE_B: MessageInteractionResponse = { value: "b" };

const iso = (ms: number): string => new Date(ms).toISOString();

const BINDINGS: MessageInteractionBindings = {
	actorId: "actor-1",
	audience: { kind: "channel", id: "room-1" },
	agentId: "agent-1",
	connector: { source: "test", accountId: "acct-1" },
	roomId: "room-1",
	sourceMessageId: "msg-1",
};

const PROFILE: ConnectorInteractionCapabilityProfile = {
	profileVersion: 1,
	profileId: "ip1:test-profile",
	connector: { source: "test", accountId: "acct-1" },
	target: { kind: "channel", id: "room-1" },
	blocks: {
		choice: { modes: ["native", "conversational"], maxSessionTtlMs: 900_000 },
		form: { modes: ["native", "conversational"], maxSessionTtlMs: 900_000 },
		followups: {
			modes: ["native", "conversational"],
			maxSessionTtlMs: 900_000,
		},
		task: { modes: ["conversational"], maxSessionTtlMs: 3_600_000 },
		secret: { modes: ["sensitive-request"], maxSessionTtlMs: 900_000 },
	},
	limits: {
		buttons: {
			supported: true,
			maxPerRow: 5,
			maxPerMessage: 20,
			maxLabelBytes: 64,
			maxCallbackBytes: 64,
		},
		lists: {
			supported: true,
			maxItems: 25,
			maxLabelBytes: 64,
			maxDescriptionBytes: 128,
		},
		modals: { supported: true, maxFields: 5, maxTitleBytes: 45 },
		forms: { supported: true, maxFields: 5, maxOptionsPerField: 25 },
		links: { supported: false, maxUrlBytes: 0 },
		edits: { supported: false, windowMs: null },
		threads: { supported: false, maxTitleBytes: 0 },
		text: { maxMessageBytes: 4096 },
		attachments: {
			supported: true,
			maxCount: 3,
			maxBytesEach: 10_000_000,
			mimeTypes: ["*/*"],
		},
	},
	nonSecretFallbacks: ["native", "conversational"],
	sensitiveFallback: "sensitive-request",
};

const CHOICE_BLOCK: ChoiceInteraction = {
	kind: "choice",
	id: "choice-1",
	scope: "deploy",
	prompt: "Pick one",
	options: [
		{ value: "a", label: "Alpha" },
		{ value: "b", label: "Beta" },
	],
};

const FORM_BLOCK: FormInteraction = {
	kind: "form",
	id: "form-1",
	fields: [
		{
			name: "region",
			type: "select",
			required: true,
			options: [
				{ value: "eu", label: "EU" },
				{ value: "us", label: "US" },
			],
		},
		{ name: "note", type: "text", maxBytes: 50 },
		{ name: "attempts", type: "number", required: true, maxBytes: 999 },
		{ name: "freeform", type: "text" },
	],
};

const FOLLOWUPS_BLOCK: FollowupsInteraction = {
	kind: "followups",
	id: "followups-1",
	options: [
		{ kind: "reply", payload: "p1", label: "One" },
		{ kind: "reply", payload: "p2", label: "Two" },
	],
};

const TASK_BLOCK: TaskInteraction = {
	kind: "task",
	threadId: "thread-1",
	title: "Long run",
};

const expectFailure = (run: () => unknown, code: string): void => {
	expect(run).toThrowError(expect.objectContaining({ code }));
};

const expectRejection = async (
	run: () => Promise<unknown>,
	code: string,
): Promise<void> => {
	await expect(run).rejects.toThrowError(expect.objectContaining({ code }));
};

function expectState<T extends MessageInteractionConsumeState["state"]>(
	consume: MessageInteractionConsumeState,
	state: T,
): Extract<MessageInteractionConsumeState, { state: T }> {
	if (consume.state !== state) {
		throw new Error(`Expected consume state ${state}, got ${consume.state}.`);
	}
	return consume;
}

type SessionOverrides = {
	reference?: string;
	expiresAt?: string;
	presetResponse?: MessageInteractionResponse | null;
	authorization?: MessageInteractionAuthorizationDecision;
};

const makeSession = (
	overrides: SessionOverrides = {},
): MessageInteractionSession => ({
	sessionVersion: 1,
	reference: overrides.reference ?? REFERENCE,
	purpose: "choice",
	blockKind: "choice",
	flow: "native",
	profileId: PROFILE.profileId,
	bindings: structuredClone(BINDINGS),
	responseSchema: {
		fields: [
			{
				name: "value",
				type: "text",
				required: true,
				options: ["a", "b"],
			},
		],
		additionalFields: false,
	},
	presetResponse: overrides.presetResponse ?? null,
	authorization: {
		decisionId: "dec-1",
		policyRevision: "rev-1",
		decidedAt: iso(NOW - 1000),
		state: "active",
		revokedAt: null,
		...(overrides.authorization ?? {}),
	},
	effect: { kind: "noop" },
	createdAt: iso(NOW - 2000),
	expiresAt: overrides.expiresAt ?? iso(NOW + 60_000),
	consume: { state: "pending" },
	revision: 0,
});

type ClaimOverrides = {
	reference?: string;
	replayKey?: string;
	response?: MessageInteractionResponse;
	claimId?: string;
	now?: number;
	claimTtlMs?: number;
	actorId?: string;
};

const claimContext = (
	overrides: ClaimOverrides = {},
): MessageInteractionClaimContext => ({
	...structuredClone(BINDINGS),
	actorId: overrides.actorId ?? BINDINGS.actorId,
	reference: overrides.reference ?? REFERENCE,
	replayKey: overrides.replayKey ?? REPLAY_KEY,
	response: overrides.response ?? RESPONSE_A,
	claimId: overrides.claimId ?? CLAIM_ID,
	now: overrides.now ?? NOW,
	claimTtlMs: overrides.claimTtlMs ?? CLAIM_TTL_MS,
});

const acquiredSession = (): MessageInteractionSession => {
	const result: MessageInteractionClaimResult = applyMessageInteractionClaim(
		makeSession(),
		claimContext(),
	);
	if (result.status !== "acquired") {
		throw new Error("Fixture failure: expected an acquired claim.");
	}
	return result.session;
};

const commitContext = (now: number = NOW) => ({
	reference: REFERENCE,
	claimId: CLAIM_ID,
	replayKey: REPLAY_KEY,
	now,
});

const committedSession = (): MessageInteractionSession =>
	applyMessageInteractionCommit(acquiredSession(), commitContext());

const receiptFor = (
	idempotencyKey: string,
	completedAtMs: number = NOW + 1000,
): MessageInteractionReceipt => ({
	receiptId: "receipt-1",
	idempotencyKey,
	status: "completed",
	completedAt: iso(completedAtMs),
	result: {},
});

const completionContext = (
	receipt: MessageInteractionReceipt,
	now: number = NOW + 1000,
) => ({
	reference: REFERENCE,
	claimId: CLAIM_ID,
	replayKey: REPLAY_KEY,
	receipt,
	now,
});

const completedSession = (): MessageInteractionSession =>
	applyMessageInteractionCompletion(
		committedSession(),
		completionContext(receiptFor(REPLAY_KEY)),
	);

describe("opaque references and callback encoding", () => {
	it("generates distinct 128-bit hex references by default", () => {
		const first = createOpaqueMessageInteractionReference();
		const second = createOpaqueMessageInteractionReference();
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(second).toMatch(/^[0-9a-f]{32}$/);
		expect(first).not.toBe(second);
	});

	it("hex-encodes a supplied random source verbatim", () => {
		const reference = createOpaqueMessageInteractionReference((size) =>
			new Uint8Array(size).fill(0x0f),
		);
		expect(reference).toBe("0f".repeat(16));
	});

	it("round-trips an encoded callback and strips only the prefix", () => {
		const encoded = encodeMessageInteractionCallback(REFERENCE);
		expect(encoded.startsWith(MESSAGE_INTERACTION_CALLBACK_PREFIX)).toBe(true);
		expect(encoded.length).toBe(MESSAGE_INTERACTION_CALLBACK_BYTES);
		expect(decodeMessageInteractionCallback(encoded)).toBe(REFERENCE);
	});

	it("decodes nothing for malformed callbacks", () => {
		const encoded = encodeMessageInteractionCallback(REFERENCE);
		expect(decodeMessageInteractionCallback(null)).toBeNull();
		expect(decodeMessageInteractionCallback(42)).toBeNull();
		expect(decodeMessageInteractionCallback({})).toBeNull();
		expect(decodeMessageInteractionCallback("")).toBeNull();
		expect(decodeMessageInteractionCallback(`xyz:${REFERENCE}`)).toBeNull();
		expect(decodeMessageInteractionCallback(encoded.slice(0, -1))).toBeNull();
		expect(
			decodeMessageInteractionCallback(
				`${MESSAGE_INTERACTION_CALLBACK_PREFIX}${REFERENCE.toUpperCase()}`,
			),
		).toBeNull();
	});

	it("rejects references that are not 32 lowercase hex characters", () => {
		expectFailure(
			() => encodeMessageInteractionCallback("nothex"),
			"INVALID_MESSAGE_INTERACTION_REFERENCE",
		);
		expectFailure(
			() => encodeMessageInteractionCallback("a".repeat(31)),
			"INVALID_MESSAGE_INTERACTION_REFERENCE",
		);
		expectFailure(
			() => encodeMessageInteractionCallback("A".repeat(32)),
			"INVALID_MESSAGE_INTERACTION_REFERENCE",
		);
	});
});

describe("response schema derivation", () => {
	it("maps choice options to values unless custom answers are allowed", () => {
		const schema = responseSchemaForInteraction(CHOICE_BLOCK, {
			maxTextResponseBytes: 12,
		});
		expect(schema.additionalFields).toBe(false);
		expect(schema.fields[0]?.name).toBe("value");
		expect(schema.fields[0]?.required).toBe(true);
		expect(schema.fields[0]?.options).toEqual(["a", "b"]);
		expect(schema.fields[0]?.maxBytes).toBe(12);

		const freeForm = responseSchemaForInteraction({
			...CHOICE_BLOCK,
			allowCustom: true,
		});
		expect(freeForm.fields[0]).not.toHaveProperty("options");
		expect(freeForm.fields[0]).not.toHaveProperty("maxBytes");
	});

	it("caps text-like form field bytes at the negotiated message budget", () => {
		const schema = responseSchemaForInteraction(FORM_BLOCK, {
			maxTextResponseBytes: 10,
		});
		const byName = new Map(schema.fields.map((field) => [field.name, field]));
		expect(byName.get("region")?.options).toEqual(["eu", "us"]);
		expect(byName.get("region")?.required).toBe(true);
		expect(byName.get("note")?.maxBytes).toBe(10);
		expect(byName.get("attempts")?.maxBytes).toBe(999);
		expect(byName.get("freeform")?.maxBytes).toBe(10);
	});

	it("refuses secret fields outside the sensitive flow and maps followups to payloads", () => {
		expectFailure(() => {
			const secretForm: FormInteraction = {
				kind: "form",
				id: "form-secret",
				fields: [{ name: "key", type: "secret", required: true }],
			};
			return responseSchemaForInteraction(secretForm);
		}, "INTERACTION_SENSITIVE_FLOW_REQUIRED");

		const followupsSchema = responseSchemaForInteraction(FOLLOWUPS_BLOCK);
		expect(followupsSchema.fields[0]?.options).toEqual(["p1", "p2"]);

		const taskSchema = responseSchemaForInteraction(TASK_BLOCK);
		expect(taskSchema.fields).toEqual([
			{ name: "acknowledged", type: "acknowledgement", required: true },
		]);
	});
});

describe("response validation", () => {
	const schema = {
		fields: [
			{ name: "value", type: "text", required: true, options: ["a", "b"] },
			{ name: "note", type: "text", required: false, maxBytes: 5 },
		],
		additionalFields: false,
	} as const;

	it("returns a defensive clone of a valid response", () => {
		const input: Record<string, unknown> = { value: "a", note: "ok" };
		const validated = validateMessageInteractionResponse(
			input as MessageInteractionResponse,
			schema,
		);
		expect(validated).toEqual(input);
		expect(validated).not.toBe(input);
		input.note = "mutated";
		expect(validated.note).toBe("ok");
	});

	it("rejects non-object payloads and unexpected additional fields", () => {
		expectFailure(() => {
			return validateMessageInteractionResponse(
				[] as unknown as MessageInteractionResponse,
				schema,
			);
		}, "INVALID_MESSAGE_INTERACTION_RESPONSE");
		expectFailure(
			() =>
				validateMessageInteractionResponse(
					null as unknown as MessageInteractionResponse,
					schema,
				),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
		expectFailure(
			() =>
				validateMessageInteractionResponse({ value: "a", extra: true }, schema),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
	});

	it("names the missing required field instead of trusting top-level shape", () => {
		try {
			validateMessageInteractionResponse({ note: "ok" }, schema);
			throw new Error("Expected validation to fail.");
		} catch (error) {
			expect(error).toMatchObject({
				code: "INVALID_MESSAGE_INTERACTION_RESPONSE",
			});
			expect((error as Error).message).toContain("value");
		}
	});

	it("enforces boolean, finite-number, and UTF-8 byte limits", () => {
		const strict = responseSchemaForInteraction(TASK_BLOCK);
		expectFailure(
			() => validateMessageInteractionResponse({ acknowledged: "yes" }, strict),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);

		const numeric = {
			fields: [{ name: "attempts", type: "number", required: true }],
			additionalFields: false,
		} as const;
		expectFailure(
			() =>
				validateMessageInteractionResponse({ attempts: Number.NaN }, numeric),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
		expectFailure(
			() => validateMessageInteractionResponse({ attempts: Infinity }, numeric),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);

		expect(
			validateMessageInteractionResponse({ value: "a", note: "éé" }, schema),
		).toBeDefined();
		expectFailure(
			() =>
				validateMessageInteractionResponse({ value: "a", note: "ééé" }, schema),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
	});

	it("restricts values to declared options with number-to-string matching", () => {
		expectFailure(
			() => validateMessageInteractionResponse({ value: "c" }, schema),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
		const rated = {
			fields: [
				{
					name: "rating",
					type: "number",
					required: true,
					options: ["1", "2"],
				},
			],
			additionalFields: false,
		} as const;
		expect(validateMessageInteractionResponse({ rating: 2 }, rated)).toEqual({
			rating: 2,
		});
		expectFailure(
			() => validateMessageInteractionResponse({ rating: 3 }, rated),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
	});
});

describe("claim transitions", () => {
	it("acquires a pending session with a first attempt and derived lease stamps", () => {
		const result = applyMessageInteractionClaim(makeSession(), claimContext());
		expect(result.status).toBe("acquired");
		if (result.status !== "acquired") return;
		const claimed = expectState(result.session.consume, "claimed");
		expect(claimed.claimId).toBe(CLAIM_ID);
		expect(claimed.attempt).toBe(1);
		expect(claimed.claimedAt).toBe(iso(NOW));
		expect(claimed.claimExpiresAt).toBe(iso(NOW + CLAIM_TTL_MS));
		expect(result.session.revision).toBe(1);
	});

	it("refuses mismatched references, invalid clocks, and invalid leases", () => {
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession(),
					claimContext({ reference: "f".repeat(32) }),
				),
			"MESSAGE_INTERACTION_REFERENCE_MISMATCH",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(makeSession(), claimContext({ now: -1 })),
			"INVALID_MESSAGE_INTERACTION_CLOCK",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession(),
					claimContext({ replayKey: "  " }),
				),
			"INVALID_MESSAGE_INTERACTION_SESSION",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession(),
					claimContext({ claimTtlMs: 0 }),
				),
			"INVALID_MESSAGE_INTERACTION_CLAIM_TTL",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession(),
					claimContext({ claimTtlMs: 9_000_000_000_000_000 }),
				),
			"INVALID_MESSAGE_INTERACTION_CLAIM_TTL",
		);
	});

	it("binds the callback to the original actor, audience, agent, account, room, and message", () => {
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession(),
					claimContext({ actorId: "someone-else" }),
				),
			"MESSAGE_INTERACTION_BINDING_MISMATCH",
		);
	});

	it("refuses revoked or expired sessions while they are still pending", () => {
		const revoked = makeSession({
			authorization: {
				decisionId: "dec-1",
				policyRevision: "rev-1",
				decidedAt: iso(NOW - 1000),
				state: "revoked",
				revokedAt: iso(NOW - 500),
			},
		});
		expectFailure(
			() => applyMessageInteractionClaim(revoked, claimContext()),
			"MESSAGE_INTERACTION_AUTHORIZATION_REVOKED",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession({ expiresAt: iso(NOW) }),
					claimContext(),
				),
			"MESSAGE_INTERACTION_EXPIRED",
		);
	});

	it("honors preset responses and refuses tampered overrides", () => {
		const preset = makeSession({ presetResponse: RESPONSE_A });
		const result = applyMessageInteractionClaim(preset, {
			...claimContext(),
			response: undefined,
		});
		expect(result.status).toBe("acquired");

		expectFailure(
			() =>
				applyMessageInteractionClaim(
					makeSession({ presetResponse: RESPONSE_A }),
					claimContext({ response: RESPONSE_B }),
				),
			"MESSAGE_INTERACTION_TAMPERED",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(makeSession(), {
					...claimContext(),
					response: undefined,
				}),
			"INVALID_MESSAGE_INTERACTION_RESPONSE",
		);
	});

	it("keeps an unexpired identical lease in progress and resumes an expired one", () => {
		const claimed = acquiredSession();
		const stillLeased = applyMessageInteractionClaim(claimed, claimContext());
		expect(stillLeased.status).toBe("in_progress");
		if (stillLeased.status !== "in_progress") return;
		expect(stillLeased.session.revision).toBe(1);

		const expiredLease = applyMessageInteractionClaim(
			claimed,
			claimContext({ now: NOW + CLAIM_TTL_MS + 1 }),
		);
		expect(expiredLease.status).toBe("resumed");
		if (expiredLease.status !== "resumed") return;
		const resumed = expectState(expiredLease.session.consume, "claimed");
		expect(resumed.attempt).toBe(2);
		expect(resumed.claimExpiresAt).toBe(
			iso(NOW + CLAIM_TTL_MS + 1 + CLAIM_TTL_MS),
		);
		expect(expiredLease.session.revision).toBe(2);
	});

	it("refuses a different response while claimed, committed, or completed", () => {
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					acquiredSession(),
					claimContext({ response: RESPONSE_B }),
				),
			"MESSAGE_INTERACTION_ALREADY_CLAIMED",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					committedSession(),
					claimContext({ response: RESPONSE_B }),
				),
			"MESSAGE_INTERACTION_ALREADY_COMMITTED",
		);
		expectFailure(
			() =>
				applyMessageInteractionClaim(
					completedSession(),
					claimContext({ response: RESPONSE_B }),
				),
			"MESSAGE_INTERACTION_ALREADY_CONSUMED",
		);
	});

	it("reports in-progress for an identical committed claim and replays a receipt when completed", () => {
		const committed = committedSession();
		expect(applyMessageInteractionClaim(committed, claimContext()).status).toBe(
			"in_progress",
		);

		const replay = applyMessageInteractionClaim(
			completedSession(),
			claimContext(),
		);
		expect(replay.status).toBe("replay");
		if (replay.status !== "replay") return;
		expect(replay.receipt).toEqual(receiptFor(REPLAY_KEY));
	});
});

describe("commit, completion, reconciliation, and revocation transitions", () => {
	it("commits only the current claim of an active authorization", () => {
		expectFailure(
			() => applyMessageInteractionCommit(makeSession(), commitContext()),
			"MESSAGE_INTERACTION_STALE_CLAIM",
		);
		expectFailure(
			() =>
				applyMessageInteractionCommit(acquiredSession(), {
					...commitContext(),
					claimId: "other-claim",
				}),
			"MESSAGE_INTERACTION_STALE_CLAIM",
		);

		const committed = committedSession();
		const state = expectState(committed.consume, "committed");
		expect(state.claimId).toBe(CLAIM_ID);
		expect(state.committedAt).toBe(iso(NOW));
		expect(committed.revision).toBe(2);
	});

	it("completes a committed session only with a receipt bound to the replay key", () => {
		expectFailure(
			() =>
				applyMessageInteractionCompletion(
					acquiredSession(),
					completionContext(receiptFor(REPLAY_KEY)),
				),
			"MESSAGE_INTERACTION_STALE_CLAIM",
		);
		const future = receiptFor(REPLAY_KEY, NOW + 2000);
		expectFailure(
			() =>
				applyMessageInteractionCompletion(
					committedSession(),
					completionContext(future),
				),
			"INVALID_MESSAGE_INTERACTION_RECEIPT",
		);
		expectFailure(
			() =>
				applyMessageInteractionCompletion(
					committedSession(),
					completionContext({
						...receiptFor("unbound-key"),
						completedAt: iso(NOW),
					}),
				),
			"INVALID_MESSAGE_INTERACTION_RECEIPT",
		);

		const completed = applyMessageInteractionCompletion(
			committedSession(),
			completionContext(receiptFor(REPLAY_KEY)),
		);
		const state = expectState(completed.consume, "completed");
		expect(state.completedAt).toBe(iso(NOW + 1000));
		expect(state.attempt).toBe(1);
		expect(state.receipt.idempotencyKey).toBe(REPLAY_KEY);
		expect(completed.revision).toBe(3);
	});

	it("is idempotent for the same receipt and refuses a different effect once completed", () => {
		const completed = completedSession();
		const again = applyMessageInteractionCompletion(
			completed,
			completionContext(receiptFor(REPLAY_KEY)),
		);
		expect(again).toEqual(completed);
		expect(again.revision).toBe(completed.revision);

		expectFailure(
			() =>
				applyMessageInteractionCompletion(
					completed,
					completionContext(receiptFor("other-idempotency-key")),
				),
			"MESSAGE_INTERACTION_ALREADY_CONSUMED",
		);
	});

	it("reconciles only a committed ambiguous interaction via its retained claim", () => {
		expectFailure(
			() =>
				applyMessageInteractionReconciliation(acquiredSession(), {
					...completionContext(receiptFor(REPLAY_KEY)),
					receipt: receiptFor(REPLAY_KEY),
				}),
			"MESSAGE_INTERACTION_NOT_COMMITTED",
		);
		const committed = committedSession();
		expectFailure(
			() =>
				applyMessageInteractionReconciliation(committed, {
					reference: REFERENCE,
					replayKey: "other-key",
					receipt: { ...receiptFor("other-key"), completedAt: iso(NOW) },
					now: NOW + 1000,
				}),
			"MESSAGE_INTERACTION_REPLAY_KEY_MISMATCH",
		);

		const reconciled = applyMessageInteractionReconciliation(committed, {
			reference: REFERENCE,
			replayKey: REPLAY_KEY,
			receipt: { ...receiptFor(REPLAY_KEY), completedAt: iso(NOW) },
			now: NOW + 1000,
		});
		expect(expectState(reconciled.consume, "completed").receipt.receiptId).toBe(
			"receipt-1",
		);
	});

	it("revokes pending or claimed authorizations, is idempotent, and refuses committed effects", () => {
		const pending = makeSession();
		const revoked = applyMessageInteractionRevocation(pending, "dec-1", NOW);
		expect(revoked.authorization.state).toBe("revoked");
		expect(revoked.authorization.revokedAt).toBe(iso(NOW));
		expect(revoked.revision).toBe(1);

		const alreadyRevoked = makeSession({
			authorization: {
				decisionId: "dec-1",
				policyRevision: "rev-1",
				decidedAt: iso(NOW - 1000),
				state: "revoked",
				revokedAt: iso(NOW - 900),
			},
		});
		expect(
			applyMessageInteractionRevocation(alreadyRevoked, "dec-1", NOW),
		).toEqual(alreadyRevoked);

		expectFailure(
			() =>
				applyMessageInteractionRevocation(makeSession(), "other-decision", NOW),
			"MESSAGE_INTERACTION_AUTHORIZATION_MISMATCH",
		);
		expectFailure(
			() => applyMessageInteractionRevocation(committedSession(), "dec-1", NOW),
			"MESSAGE_INTERACTION_EFFECT_COMMITTED",
		);

		const claimedThenRevoked = applyMessageInteractionRevocation(
			acquiredSession(),
			"dec-1",
			NOW,
		);
		expect(claimedThenRevoked.authorization.state).toBe("revoked");
	});
});

describe("in-memory store", () => {
	const referenceFor = (fill: number): string =>
		createOpaqueMessageInteractionReference((size) =>
			new Uint8Array(size).fill(fill),
		);

	it("stores clones, refuses duplicate references, and reports missing sessions", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		await store.create(makeSession());
		await expectRejection(
			() => store.create(makeSession()),
			"MESSAGE_INTERACTION_REFERENCE_COLLISION",
		);
		expect(await store.get("missing")).toBeNull();

		const fetched = await store.get(REFERENCE);
		expect(fetched?.reference).toBe(REFERENCE);
		if (fetched) fetched.reference = "tampered";
		expect((await store.get(REFERENCE))?.reference).toBe(REFERENCE);

		await expectRejection(
			() => store.claimIfCurrent(claimContext({ reference: "missing" })),
			"MESSAGE_INTERACTION_NOT_FOUND",
		);
	});

	it("runs the full exactly-once lifecycle through atomic store transitions", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		await store.create(makeSession());

		const first = await store.claimIfCurrent(claimContext());
		expect(first.status).toBe("acquired");

		const second = await store.claimIfCurrent(claimContext());
		expect(second.status).toBe("in_progress");

		const committed = await store.commitIfClaimed(commitContext());
		expectState(committed.consume, "committed");
		await expectRejection(
			() => store.commitIfClaimed(commitContext()),
			"MESSAGE_INTERACTION_STALE_CLAIM",
		);

		const completed = await store.completeIfClaimed(
			completionContext(receiptFor(REPLAY_KEY)),
		);
		expect(expectState(completed.consume, "completed").attempt).toBe(1);

		const replay = await store.claimIfCurrent(claimContext());
		expect(replay.status).toBe("replay");
		if (replay.status !== "replay") return;
		expect(replay.receipt.idempotencyKey).toBe(REPLAY_KEY);

		const stored = await store.get(REFERENCE);
		expect(stored?.consume.state).toBe("completed");
	});

	it("serializes concurrent claims of the same pending session", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		await store.create(makeSession());
		const [first, second] = await Promise.all([
			store.claimIfCurrent(claimContext()),
			store.claimIfCurrent(claimContext()),
		]);
		expect(first.status).toBe("acquired");
		expect(second.status).toBe("in_progress");
	});

	it("lists committed sessions sorted by reference and bounded by limit and time", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		expect(
			await store.listCommitted({ committedBefore: NOW, limit: 10 }),
		).toEqual([]);

		const refB = referenceFor(0x02);
		const refA = referenceFor(0x01);
		await store.create(makeSession({ expiresAt: iso(NOW + 60_000) }));
		const bAcquired = applyMessageInteractionClaim(
			makeSession({ reference: refB }),
			claimContext({ reference: refB, replayKey: "key-b" }),
		);
		if (bAcquired.status !== "acquired") throw new Error("fixture");
		await store.create(bAcquired.session);
		await store.commitIfClaimed({
			reference: refB,
			claimId: CLAIM_ID,
			replayKey: "key-b",
			now: NOW + 2000,
		});
		const aAcquired = applyMessageInteractionClaim(
			makeSession({ reference: refA }),
			claimContext({ reference: refA, replayKey: "key-a" }),
		);
		if (aAcquired.status !== "acquired") throw new Error("fixture");
		await store.create(aAcquired.session);
		await store.commitIfClaimed({
			reference: refA,
			claimId: CLAIM_ID,
			replayKey: "key-a",
			now: NOW + 1000,
		});

		expect(
			await store.listCommitted({ committedBefore: NOW + 1500, limit: 10 }),
		).toEqual([expect.objectContaining({ reference: refA })]);
		expect(
			await store.listCommitted({ committedBefore: NOW + 2500, limit: 1 }),
		).toEqual([expect.objectContaining({ reference: refA })]);

		await expectRejection(
			() => store.listCommitted({ committedBefore: NOW, limit: 0 }),
			"INVALID_MESSAGE_INTERACTION_RECONCILIATION_LIMIT",
		);
		await expectRejection(
			() => store.listCommitted({ committedBefore: NOW, limit: -3 }),
			"INVALID_MESSAGE_INTERACTION_RECONCILIATION_LIMIT",
		);
		await expectRejection(
			() => store.listCommitted({ committedBefore: NOW, limit: 2.5 }),
			"INVALID_MESSAGE_INTERACTION_RECONCILIATION_LIMIT",
		);
	});

	it("sweeps each terminal state at its own timestamp and reports the count", async () => {
		const store = new InMemoryMessageInteractionSessionStore();

		const pendingRef = referenceFor(0x11);
		await store.create(makeSession({ expiresAt: iso(NOW + 1000) }));

		const claimedRef = referenceFor(0x12);
		const claimedFixture = applyMessageInteractionClaim(
			makeSession({ reference: claimedRef, expiresAt: iso(NOW + 1000) }),
			claimContext({ reference: claimedRef, replayKey: "key-claimed" }),
		);
		if (claimedFixture.status !== "acquired") throw new Error("fixture");
		await store.create(claimedFixture.session);

		const committedRef = referenceFor(0x13);
		const committedFixture = applyMessageInteractionClaim(
			makeSession({ reference: committedRef }),
			claimContext({ reference: committedRef, replayKey: "key-c" }),
		);
		if (committedFixture.status !== "acquired") throw new Error("fixture");
		await store.create(committedFixture.session);
		await store.commitIfClaimed({
			reference: committedRef,
			claimId: CLAIM_ID,
			replayKey: "key-c",
			now: NOW + 2000,
		});

		const completedRef = referenceFor(0x14);
		const completedFixture = applyMessageInteractionClaim(
			makeSession({ reference: completedRef }),
			claimContext({ reference: completedRef, replayKey: "key-d" }),
		);
		if (completedFixture.status !== "acquired") throw new Error("fixture");
		await store.create(completedFixture.session);
		await store.commitIfClaimed({
			reference: completedRef,
			claimId: CLAIM_ID,
			replayKey: "key-d",
			now: NOW + 4000,
		});
		await store.completeIfClaimed({
			reference: completedRef,
			claimId: CLAIM_ID,
			replayKey: "key-d",
			receipt: receiptFor("key-d", NOW + 5000),
			now: NOW + 5000,
		});

		expect(await store.deleteExpired(NOW + 3000)).toBe(3);
		expect(await store.get(pendingRef)).toBeNull();
		expect(await store.get(claimedRef)).toBeNull();
		expect(await store.get(committedRef)).toBeNull();
		expect((await store.get(completedRef))?.consume.state).toBe("completed");

		expect(await store.deleteExpired(NOW + 5000)).toBe(1);
		expect(await store.deleteExpired(NOW + 9999)).toBe(0);
	});

	it("revokes through the store and persists the transition", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		await store.create(makeSession());
		const revoked = await store.revokeAuthorization({
			reference: REFERENCE,
			decisionId: "dec-1",
			now: NOW,
		});
		expect(revoked.authorization.state).toBe("revoked");
		expect((await store.get(REFERENCE))?.authorization.state).toBe("revoked");

		await expectRejection(
			() =>
				store.revokeAuthorization({
					reference: REFERENCE,
					decisionId: "other-decision",
					now: NOW,
				}),
			"MESSAGE_INTERACTION_AUTHORIZATION_MISMATCH",
		);
	});
});

describe("authority end-to-end", () => {
	const authority = (
		store = new InMemoryMessageInteractionSessionStore(),
	): MessageInteractionSessionAuthority =>
		new MessageInteractionSessionAuthority(store, {
			clock: () => NOW,
			referenceFactory: () => REFERENCE,
		});

	const createArgs = () => ({
		block: CHOICE_BLOCK,
		profile: PROFILE,
		bindings: structuredClone(BINDINGS),
		purpose: "choice" as const,
		flow: "native" as const,
		authorization: {
			decisionId: "dec-1",
			policyRevision: "rev-1",
			decidedAt: iso(NOW - 1000),
		},
		effect: { kind: "noop" },
		expiresAt: iso(NOW + 60_000),
	});

	it("creates a session whose callback data is the encoded opaque reference", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		const { session, callbackData } = await authority(store).create(
			createArgs(),
		);
		expect(callbackData).toBe(
			`${MESSAGE_INTERACTION_CALLBACK_PREFIX}${REFERENCE}`,
		);
		expect(decodeMessageInteractionCallback(callbackData)).toBe(REFERENCE);
		expect(session.consume).toEqual({ state: "pending" });
		expect(session.revision).toBe(0);
		expect(session.authorization.state).toBe("active");
		const stored = await store.get(REFERENCE);
		expect(stored?.profileId).toBe(PROFILE.profileId);
	});

	it("refuses flow, binding, expiry, and sensitive-flow mismatches at creation", async () => {
		await expectRejection(
			() => authority().create({ ...createArgs(), flow: "conversational" }),
			"INTERACTION_FLOW_NOT_NEGOTIATED",
		);
		await expectRejection(
			() =>
				authority().create({
					...createArgs(),
					bindings: {
						...structuredClone(BINDINGS),
						connector: { source: "test", accountId: "other-account" },
					},
				}),
			"MESSAGE_INTERACTION_PROFILE_BINDING_MISMATCH",
		);
		await expectRejection(
			() =>
				authority().create({
					...createArgs(),
					expiresAt: iso(NOW + 900_001),
				}),
			"INVALID_MESSAGE_INTERACTION_EXPIRY",
		);
		await expectRejection(
			() =>
				authority().create({
					...createArgs(),
					expiresAt: "2026-01-01T00:00:00Z",
				}),
			"INVALID_MESSAGE_INTERACTION_EXPIRY",
		);
		const secretBlock: SecretInteraction = {
			kind: "secret",
			id: "secret-1",
			secretKind: "oauth",
			provider: "GitHub",
		};
		await expectRejection(
			() =>
				authority().create({
					...createArgs(),
					block: secretBlock,
					purpose: "auth" as const,
				}),
			"INTERACTION_SENSITIVE_FLOW_REQUIRED",
		);
	});

	it("executes the effect exactly once and replays the retained receipt afterwards", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		let executions = 0;
		const executor: MessageInteractionEffectExecutor = {
			execute: async ({ idempotencyKey }) => {
				executions += 1;
				return receiptFor(idempotencyKey, NOW);
			},
		};

		const { callbackData } = await authority(store).create(createArgs());
		const outcome = await authority(store).consumeWithOutcome({
			callbackData,
			bindings: structuredClone(BINDINGS),
			replayKey: REPLAY_KEY,
			response: RESPONSE_A,
			executor,
		});
		expect(outcome.status).toBe("completed");
		if (outcome.status !== "completed") return;
		expect(outcome.receipt.idempotencyKey).toBe(REPLAY_KEY);
		expect(executions).toBe(1);

		const replay = await authority(store).consumeWithOutcome({
			callbackData,
			bindings: structuredClone(BINDINGS),
			replayKey: REPLAY_KEY,
			response: RESPONSE_A,
			executor,
		});
		expect(replay.status).toBe("replay");
		if (replay.status !== "replay") return;
		expect(replay.receipt.idempotencyKey).toBe(REPLAY_KEY);
		expect(executions).toBe(1);

		const legacy = await authority(store).consume({
			callbackData,
			bindings: structuredClone(BINDINGS),
			replayKey: REPLAY_KEY,
			response: RESPONSE_A,
			executor,
		});
		expect("receiptId" in legacy ? legacy.receiptId : legacy.status).toBe(
			"receipt-1",
		);

		await expectRejection(
			() =>
				authority(store).consumeWithOutcome({
					callbackData,
					bindings: {
						...structuredClone(BINDINGS),
						actorId: "someone-else",
					},
					replayKey: REPLAY_KEY,
					response: RESPONSE_A,
					executor,
				}),
			"MESSAGE_INTERACTION_BINDING_MISMATCH",
		);
	});
});
