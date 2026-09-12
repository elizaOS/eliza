/**
 * Deterministic action coverage for the #25284 send-consent gate: planner
 * tool-call flags can never authorize a send_draft, only a real subsequent
 * user turn confirming the exact previewed draft snapshot can, and every
 * mutated/replayed/concurrent/cross-actor/cross-room path sends nothing.
 * Harness is fully deterministic — an in-memory runtime cache plus a spy
 * adapter around the real TriageService/MessageRefStore; no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../../types/index.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type {
	DraftRecord,
	DraftRequest,
	MessageAdapterCapabilities,
	MessageRef,
} from "../types.ts";
import {
	__resetSendConsentStateForTests,
	draftConsentDigest,
	PRINCIPAL_RANK_ADMIN,
	PRINCIPAL_RANK_USER,
	resolveMessagePrincipalRole,
	SEND_CONSENT_TTL_MS,
} from "./send-consent.ts";
import { sendDraftAction } from "./sendDraft.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ROOM_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const OTHER_ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;
const WORLD_ID = "66666666-6666-6666-6666-666666666666" as UUID;

/** In-memory cache satisfying the IAgentRuntime cache surface the gate uses. */
function makeCache(): Pick<
	IAgentRuntime,
	"getCache" | "setCache" | "deleteCache"
> & { __map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	return {
		__map: map,
		getCache: async <T>(key: string) => map.get(key) as T | undefined,
		setCache: async <T>(key: string, value: T) => {
			map.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => map.delete(key),
	};
}

let messageIdCounter = 0;
function makeMessage(args: {
	entityId?: UUID;
	roomId?: UUID;
	text?: string;
	/** Explicit message id + createdAt for turn-ordering tests (#25284 r1). */
	id?: string;
	createdAt?: number;
}): Memory {
	messageIdCounter += 1;
	return {
		id: (args.id ??
			`44444444-4444-4444-4444-${String(messageIdCounter).padStart(12, "0")}`) as UUID,
		entityId: args.entityId ?? USER_ID,
		agentId: AGENT_ID,
		roomId: args.roomId ?? ROOM_ID,
		createdAt: args.createdAt ?? Date.now(),
		content: { text: args.text ?? "", source: "test" },
	} as Memory;
}

/**
 * Spy adapter: records every sendDraft call and returns a distinct external id.
 * The provider spy is the proof that a path did or did not deliver. Registered
 * on the REAL TriageService so the full draft-store → in-flight dedupe →
 * provider path executes.
 */
const sendSpy = vi.fn();

class SpyAdapter extends BaseMessageAdapter {
	readonly source = "gmail" as const;
	isAvailable(): boolean {
		return true;
	}
	capabilities(): MessageAdapterCapabilities {
		return {
			list: false,
			search: false,
			manage: {},
			send: { reply: true, new: true },
			worlds: "single",
			channels: "none",
		};
	}
	protected listMessagesImpl(): Promise<MessageRef[]> {
		return Promise.resolve([]);
	}
	protected async createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		return { draftId: `spy:${draft.body}`, preview: draft.body };
	}
	async sendDraft(
		_runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }> {
		// Record the bytes actually delivered: resolve the id to the current
		// store snapshot, so byte-level assertions can prove WHICH content a
		// path sent (#25284 r3).
		const record = getDefaultTriageService().getStore().getDraft(draftId);
		sendSpy(draftId, record?.body ?? null);
		return { externalId: `ext-${sendSpy.mock.calls.length}` };
	}
}

function makeRuntime(args?: {
	worldRoles?: Record<string, string>;
	agentId?: UUID;
	noWorld?: boolean;
}): IAgentRuntime {
	const cache = makeCache();
	const agentId = args?.agentId ?? AGENT_ID;
	const roles: Record<string, string> = args?.worldRoles ?? {
		[USER_ID]: "USER",
	};
	const world = {
		id: WORLD_ID,
		metadata: { roles },
	};
	const runtime = {
		agentId,
		...cache,
		getRoom: async () =>
			args?.noWorld ? null : { id: ROOM_ID, worldId: WORLD_ID },
		getWorld: async () => (args?.noWorld ? null : world),
	} as unknown as IAgentRuntime;
	return runtime;
}

function seedDraft(overrides?: Partial<DraftRecord>): DraftRecord {
	const record: DraftRecord = {
		draftId: "local:test-draft-1",
		source: "gmail",
		to: [{ identifier: "jane@example.com", displayName: "Jane" }],
		body: "Running five minutes late.",
		subject: undefined,
		preview: "[gmail] To: Jane\nRunning five minutes late.",
		createdAtMs: Date.now(),
		sent: false,
		...overrides,
	};
	getDefaultTriageService().getStore().saveDraft(record);
	return record;
}

/** Invoke the real action handler the way the umbrella dispatch does. */
async function runSendDraft(args: {
	runtime: IAgentRuntime;
	message: Memory;
	parameters: Record<string, unknown>;
	callbacks?: HandlerCallback[];
}): Promise<ActionResult> {
	const options = { parameters: args.parameters } as unknown as HandlerOptions;
	const result = await sendDraftAction.handler(
		args.runtime,
		args.message,
		undefined as unknown as State,
		options,
	);
	return result as ActionResult;
}

beforeEach(() => {
	__resetDefaultTriageServiceForTests();
	__resetSendConsentStateForTests();
	sendSpy.mockClear();
	getDefaultTriageService().register(new SpyAdapter());
});

afterEach(async () => {
	// The service reset in beforeEach also drops the process-global default's
	// store, and each test builds its own runtime/cache, so pending consent
	// records cannot leak between tests. Nothing further to clear.
});

describe("#25284 send-consent gate — planner flags can never authorize", () => {
	it("planner-asserted confirmed:true sends nothing on the first turn", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId, confirmed: true },
		});
		expect(result.data).toMatchObject({
			requiresConfirmation: true,
			consentStatus: "pending",
		});
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});

	it("planner-asserted confirmed:true STILL sends nothing on a later turn unless the user text confirms", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		// Turn 1: preview ask (arms consent)
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId, confirmed: true },
		});
		// Turn 2: planner again asserts confirmed:true but the USER text is a question
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "what would it look like?" }),
			parameters: { draftId: draft.draftId, confirmed: true },
		});
		expect(result.data).toMatchObject({ consentStatus: "stale" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});

	it("an explicit user 'yes' on a later turn sends exactly once", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(result.success).toBe(true);
		expect(result.data).not.toHaveProperty("requiresConfirmation");
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});
});

describe("#25284 send-consent gate — interrogative replies are questions, not consent (#27932 review)", () => {
	const interrogatives = [
		"did you send it?",
		"Did you send the email?",
		"does it send?",
		"did that send?",
		"thanks did you send it",
		"did you send it just now?",
		"did you send it",
		// RP review R1: a question mark ANYWHERE makes the reply a question,
		// even when trailing punctuation/quotes/words would otherwise survive
		// the residue filter and reduce to a bare affirmative.
		"send it?!",
		"send it?.",
		'"send it?"',
		"send it? please",
		"ok send it? thanks",
		"ok？send it",
		// RP review R2: non-Latin question-mark forms must not survive either.
		"send it؟",
		"send it﹖",
		"send it︖",
		// RP review R3: the class is now the complete Unicode question-mark
		// set (name-derived) — pin the exotic locales it called out.
		"send it¿",
		"send it՞",
		"send it؟ yes",
		// RP review R3b: medieval question mark + interrobangs.
		"send it⹔",
		"send it‽",
		"send it⸘",
	];
	for (const text of interrogatives) {
		it(`interrogative "${text}" re-prompts instead of sending`, async () => {
			const runtime = makeRuntime();
			const draft = seedDraft();
			await runSendDraft({
				runtime,
				message: makeMessage({ text: "send the draft" }),
				parameters: { draftId: draft.draftId },
			});
			const result = await runSendDraft({
				runtime,
				message: makeMessage({ text }),
				parameters: { draftId: draft.draftId },
			});
			expect(result.data).toMatchObject({ consentStatus: "stale" });
			expect(sendSpy).toHaveBeenCalledTimes(0);
		});
	}

	it("a reply carrying a question mark is a question, while terminal punctuation without one still confirms", async () => {
		// Belt-and-braces must be additive: "ok send it?" — the user asking
		// whether to send — stays a question (stale), but "ok, send it." with
		// terminal punctuation still confirms. Punctuation is already
		// stripped by the residue filter; only the QUESTION MARK carries
		// question intent.
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "ok send it?" }),
			parameters: { draftId: draft.draftId },
		});
		expect(result.data).toMatchObject({ consentStatus: "stale" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});
});

describe("#25284 send-consent gate — qualified/modified confirmation refuses", () => {
	const qualified = [
		"yes, but change the subject",
		"yes send it to Bob instead",
		"ok but wait until tomorrow",
	];
	for (const text of qualified) {
		it(`qualified reply "${text}" does not authorize`, async () => {
			const runtime = makeRuntime();
			const draft = seedDraft();
			await runSendDraft({
				runtime,
				message: makeMessage({ text: "send the draft" }),
				parameters: { draftId: draft.draftId },
			});
			const result = await runSendDraft({
				runtime,
				message: makeMessage({ text }),
				parameters: { draftId: draft.draftId },
			});
			expect(result.data).toMatchObject({ consentStatus: "stale" });
			expect(sendSpy).toHaveBeenCalledTimes(0);
		});
	}

	it("bare affirmatives authorize", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "ok, send it." }),
			parameters: { draftId: draft.draftId },
		});
		expect(result.success).toBe(true);
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});
});

describe("#25284 send-consent gate — cross-actor/cross-room/mutation/replay", () => {
	it("a different actor's yes does not authorize", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		// The other actor has no role in this world: the per-op principal
		// floor denies them outright — before consent is even consulted.
		const result = await runSendDraft({
			runtime,
			message: makeMessage({
				entityId: "55555555-5555-5555-5555-555555555555" as UUID,
				text: "yes",
			}),
			parameters: { draftId: draft.draftId },
		});
		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			error: "SEND_PRINCIPAL_ROLE_DENIED",
			callerRole: "GUEST",
		});
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});

	it("a GUEST-role sender is denied even for their own previewed draft", async () => {
		const runtime = makeRuntime({ worldRoles: { [USER_ID]: "GUEST" } });
		const draft = seedDraft();
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({ error: "SEND_PRINCIPAL_ROLE_DENIED" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});

	it("a yes from a different room does not authorize the original room's draft", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ roomId: OTHER_ROOM_ID, text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		// The other room's turn arms ITS OWN pending record for that room
		// (single-pending is per actor+room); it can never confirm the
		// original room's armed consent, and nothing is sent.
		expect(result.data).toMatchObject({ consentStatus: "pending" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
		// The original room must still require its own confirmation.
		const again = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(again.data).toMatchObject({
			draftId: draft.draftId,
			externalId: "ext-1",
		});
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});

	it("a mutated draft (edited body) re-arms the CURRENT preview instead of dead-ending", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		seedDraft({
			draftId: draft.draftId,
			body: "Actually — send this instead.",
		});
		// The "yes" answered the ORIGINAL preview, so it must not send the
		// mutated bytes; the gate re-arms the mutated preview instead.
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(result.data).toMatchObject({ consentStatus: "pending" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
		// A subsequent bare yes now answers the MUTATED preview and sends.
		const confirmed = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		// A confirmed send returns the sent-record marker (externalId), not
		// a consentStatus key.
		expect(confirmed.data).toMatchObject({ externalId: expect.any(String) });
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});

	it("an older affirmative turn replayed after arming never confirms (#25284 r1 F2)", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({
				id: "arm-1",
				createdAt: 5_000,
				text: "send the draft",
			}),
			parameters: { draftId: draft.draftId },
		});
		const replay = await runSendDraft({
			runtime,
			message: makeMessage({ id: "old-0", createdAt: 1_000, text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(replay.data).toMatchObject({ consentStatus: "stale" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
		// The record survives the blocked replay; a genuine later yes works.
		const good = await runSendDraft({
			runtime,
			message: makeMessage({ id: "new-2", createdAt: 6_000, text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(good.data).toMatchObject({ externalId: expect.any(String) });
		expect(sendSpy).toHaveBeenCalledTimes(1);
	});

	it("replay: a second yes after a confirmed send does not send again", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(sendSpy).toHaveBeenCalledTimes(1);
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(sendSpy).toHaveBeenCalledTimes(1);
		// The service short-circuits on sent drafts; the result is the prior record.
		expect(result.success).toBe(true);
	});

	it("refusal cancels the pending consent and sends nothing", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ text: "no, cancel it" }),
			parameters: { draftId: draft.draftId },
		});
		expect(result.data).toMatchObject({
			cancelled: true,
			consentStatus: "cancelled",
		});
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});

	it("a refusal clause AFTER an affirmative cancels too (#25284 r1 F4)", async () => {
		for (const reply of [
			"yes please don't send",
			"ok, don't send it",
			"sure — cancel that",
		]) {
			const runtime = makeRuntime();
			const draft = seedDraft();
			await runSendDraft({
				runtime,
				message: makeMessage({ text: "send the draft" }),
				parameters: { draftId: draft.draftId },
			});
			const result = await runSendDraft({
				runtime,
				message: makeMessage({ text: reply }),
				parameters: { draftId: draft.draftId },
			});
			expect(result.data).toMatchObject({ consentStatus: "cancelled" });
			expect(sendSpy).toHaveBeenCalledTimes(0);
			sendSpy.mockClear();
		}
		// After a cancellation nothing is armed: a bare yes re-arms a
		// preview rather than sending.
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "ok, don't send it" }),
			parameters: { draftId: draft.draftId },
		});
		const rearm = await runSendDraft({
			runtime,
			message: makeMessage({ text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(rearm.data).toMatchObject({ consentStatus: "pending" });
		expect(sendSpy).toHaveBeenCalledTimes(0);
	});
});

describe("#25284 send-consent gate — concurrency", () => {
	it("two simultaneous yes turns produce exactly one provider call", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		await runSendDraft({
			runtime,
			message: makeMessage({ text: "send the draft" }),
			parameters: { draftId: draft.draftId },
		});
		const results = await Promise.all([
			runSendDraft({
				runtime,
				message: makeMessage({ text: "yes" }),
				parameters: { draftId: draft.draftId },
			}),
			runSendDraft({
				runtime,
				message: makeMessage({ text: "yes" }),
				parameters: { draftId: draft.draftId },
			}),
		]);
		expect(sendSpy).toHaveBeenCalledTimes(1);
		const successes = results.filter(
			(r) => !r.data?.requiresConfirmation,
		).length;
		// Exactly one confirmation wins; the loser re-arms the preview or is
		// idempotently short-circuited by the service's sent flag.
		expect(successes).toBeGreaterThanOrEqual(1);
	});
});

describe("#25284 per-op principal admission", () => {
	it("the agent itself resolves OWNER", async () => {
		const runtime = makeRuntime();
		const admission = await resolveMessagePrincipalRole(
			runtime,
			makeMessage({ entityId: AGENT_ID }),
		);
		expect(admission.role).toBe("OWNER");
	});

	it("an unresolvable LOCAL sender keeps the historical USER floor; unknown connector sources stay GUEST", async () => {
		const runtime = makeRuntime({ noWorld: true });
		const local = await resolveMessagePrincipalRole(
			runtime,
			makeMessage({ entityId: USER_ID }),
		);
		// local/test-source traffic keeps the roles.ts USER floor
		expect(local.rank).toBe(PRINCIPAL_RANK_USER);

		const connector = await resolveMessagePrincipalRole(runtime, {
			...makeMessage({ entityId: USER_ID }),
			content: { text: "yes", source: "discord" },
		} as Memory);
		// an unknown non-local connector sender cannot outrank a resolved stranger
		expect(connector.role).toBe("GUEST");
		expect(connector.rank).toBeLessThan(PRINCIPAL_RANK_USER);
	});

	it("a role-store failure fails closed below USER, never the local-sender floor (#25284 r1 F1)", async () => {
		const runtime = {
			agentId: AGENT_ID,
			getRoom: async () => {
				throw new Error("db down");
			},
		} as unknown as IAgentRuntime;
		const admission = await resolveMessagePrincipalRole(
			runtime,
			makeMessage({ entityId: USER_ID }),
		);
		// An authorization-system outage must deny, not grant: rank 0 sits
		// below every tier including GUEST.
		expect(admission.rank).toBe(0);
		expect(admission.rank).toBeLessThan(PRINCIPAL_RANK_USER);
	});

	it("role floors compare against the canonical ranks", () => {
		expect(PRINCIPAL_RANK_USER).toBeLessThan(PRINCIPAL_RANK_ADMIN);
	});
});

describe("#25284 consent digest stability", () => {
	it("digest ignores derived/post-send bookkeeping but binds content", () => {
		const base: DraftRecord = {
			draftId: "d1",
			source: "telegram",
			to: [{ identifier: "bob" }],
			body: "hello",
			preview: "[telegram] To: bob\nhello",
			createdAtMs: 1_000,
			sent: false,
		};
		expect(draftConsentDigest(base)).toBe(
			draftConsentDigest({ ...base, sent: true, sentExternalId: "ext-1" }),
		);
		expect(draftConsentDigest(base)).toBe(
			draftConsentDigest({ ...base, preview: "different preview" }),
		);
		expect(draftConsentDigest(base)).not.toBe(
			draftConsentDigest({ ...base, body: "changed" }),
		);
		expect(draftConsentDigest(base)).not.toBe(
			draftConsentDigest({
				...base,
				to: [{ identifier: "bob" }, { identifier: "alice" }],
			}),
		);
	});

	it("recipient order does not change the digest", () => {
		const a: DraftRecord = {
			draftId: "d1",
			source: "telegram",
			to: [{ identifier: "bob", displayName: "Bob" }, { identifier: "alice" }],
			body: "hello",
			preview: "p",
			createdAtMs: 1,
			sent: false,
		};
		expect(draftConsentDigest(a)).toBe(
			draftConsentDigest({
				...a,
				to: [
					{ identifier: "alice" },
					{ identifier: "bob", displayName: "Bob" },
				],
			}),
		);
	});
});

describe("#25284 send-consent gate — RP review round 3 findings", () => {
	it("an expired arming cannot be confirmed by a later yes (TTL)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		try {
			const runtime = makeRuntime();
			const draft = seedDraft();
			// Turn 1 arms the consent.
			await runSendDraft({
				runtime,
				message: makeMessage({ id: "m-arm", createdAt: 1_000_000, text: "" }),
				parameters: { draftId: draft.draftId },
			});
			expect(sendSpy).toHaveBeenCalledTimes(0);
			// Wall clock advances past the 5-minute TTL window.
			vi.advanceTimersByTime(SEND_CONSENT_TTL_MS + 60_000);
			const result = await runSendDraft({
				runtime,
				message: makeMessage({
					id: "m-yes-late",
					createdAt: 1_000_000 + SEND_CONSENT_TTL_MS + 60_000,
					text: "yes",
				}),
				parameters: { draftId: draft.draftId },
			});
			expect(sendSpy).toHaveBeenCalledTimes(0);
			expect(result.data?.requiresConfirmation).toBe(true);
			// The expiry path must leave a CONFIRMABLE re-armed preview: a
			// later bare yes on a fresh turn now sends exactly once.
			const sent = await runSendDraft({
				runtime,
				message: makeMessage({
					id: "m-yes-fresh",
					createdAt: 1_000_000 + SEND_CONSENT_TTL_MS + 120_000,
					text: "yes",
				}),
				parameters: { draftId: draft.draftId },
			});
			expect(sendSpy).toHaveBeenCalledTimes(1);
			expect(String(sent.text)).toContain("Sent it.");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a role-eligible different USER cannot consume another actor's pending consent", async () => {
		const OTHER_USER: UUID = "55555555-5555-5555-5555-555555555555" as UUID;
		const runtime = makeRuntime({
			worldRoles: { [USER_ID]: "USER", [OTHER_USER]: "USER" },
		});
		const draft = seedDraft();
		// USER arms consent for their own preview in the room.
		await runSendDraft({
			runtime,
			message: makeMessage({ id: "m-arm", createdAt: 1_000, text: "" }),
			parameters: { draftId: draft.draftId },
		});
		// A different role-eligible USER says yes in the same room.
		const result = await runSendDraft({
			runtime,
			message: makeMessage({
				entityId: OTHER_USER,
				id: "m-other-yes",
				createdAt: 2_000,
				text: "yes",
			}),
			parameters: { draftId: draft.draftId },
		});
		expect(sendSpy).toHaveBeenCalledTimes(0);
		expect(result.data?.requiresConfirmation).toBe(true);
	});

	it("a draft mutated between the consent gate and the provider call sends nothing and re-previews (TOCTOU)", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		const t0 = 1_000;
		await runSendDraft({
			runtime,
			message: makeMessage({ id: "m-arm", createdAt: t0, text: "" }),
			parameters: { draftId: draft.draftId },
		});
		// Mutate the stored bytes so the SECOND store read — the one inside
		// TriageService.sendDraft, after the gate already confirmed the
		// first read — observes different content than what was consented.
		const store = getDefaultTriageService().getStore();
		const realGet = store.getDraft.bind(store);
		let reads = 0;
		vi.spyOn(store, "getDraft").mockImplementation((id: string) => {
			const rec = realGet(id);
			reads += 1;
			// Read 1: the action's `existing` load (consented). Read 2: the
			// service's post-load validation. Read 3: the pre-adapter
			// revalidation — the LAST instant the service can still refuse.
			// Mutate there: the swap must fail closed with zero sends.
			if (reads === 3 && rec) {
				const mutated = { ...rec, body: "Swapped hostile bytes." };
				store.saveDraft(mutated);
				return mutated;
			}
			return rec;
		});
		const result = await runSendDraft({
			runtime,
			message: makeMessage({ id: "m-yes", createdAt: t0 + 1, text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(sendSpy).toHaveBeenCalledTimes(0);
		expect(result.data?.requiresConfirmation).toBe(true);
		expect(String(result.text)).toContain("changed after you approved");
		// Complete the designed cycle: the mismatch recovery ARMED the
		// mutated preview it showed, so a fresh later user yes sends exactly
		// the bytes the user just saw — one send, mutated body, nothing else.
		const sent = await runSendDraft({
			runtime,
			message: makeMessage({
				id: "m-yes-mutated",
				createdAt: t0 + 2,
				text: "yes",
			}),
			parameters: { draftId: draft.draftId },
		});
		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(sendSpy).toHaveBeenLastCalledWith(
			draft.draftId,
			"Swapped hostile bytes.",
		);
		expect(String(sent.text)).toContain("Sent it.");
	});

	it("a failed send can be re-confirmed after re-arming (consumed key is per-arming)", async () => {
		const runtime = makeRuntime();
		const draft = seedDraft();
		const t0 = 1_000;
		await runSendDraft({
			runtime,
			message: makeMessage({ id: "m-arm", createdAt: t0, text: "" }),
			parameters: { draftId: draft.draftId },
		});
		// Consume the arming's consent via a real user yes, with the provider
		// call itself FAILING after consent was consumed (a transient
		// provider outage, exercised through the action path).
		sendSpy.mockImplementationOnce(() => {
			throw new Error("provider 503");
		});
		await expect(
			runSendDraft({
				runtime,
				message: makeMessage({
					id: "m-yes",
					createdAt: t0 + 1,
					text: "yes",
				}),
				parameters: { draftId: draft.draftId },
			}),
		).rejects.toThrow("provider 503");
		expect(sendSpy).toHaveBeenCalledTimes(1);
		// Re-arm via a new preview turn (the planner re-presents the draft).
		const rearmed = await runSendDraft({
			runtime,
			message: makeMessage({ id: "m-arm2", createdAt: t0 + 2, text: "" }),
			parameters: { draftId: draft.draftId },
		});
		expect(rearmed.data?.requiresConfirmation).toBe(true);
		// The NEXT later user yes confirms again: the consumed set must not
		// block a fresh arming of the same content after a failed send.
		const resent = await runSendDraft({
			runtime,
			message: makeMessage({ id: "m-yes2", createdAt: t0 + 3, text: "yes" }),
			parameters: { draftId: draft.draftId },
		});
		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(String(resent.text)).toContain("Sent it.");
	});
});
