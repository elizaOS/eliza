/**
 * Deterministic contract coverage for negotiated profiles and the durable
 * message-interaction claim/execute/receipt state machine. No model is mocked.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	ChoiceInteraction,
	FormInteraction,
} from "../../types/interactions";
import {
	BUTTON_INTERACTION_PROFILE,
	CONVERSATIONAL_INTERACTION_PROFILE,
	RICH_INTERACTION_PROFILE,
} from "./profile-catalog";
import {
	ConnectorInteractionProfileRegistry,
	createConnectorInteractionCapabilityProfile,
	negotiateInteractionDelivery,
	normalizeConnectorInteractionCapabilityProfile,
} from "./profiles";
import {
	createOpaqueMessageInteractionReference,
	decodeMessageInteractionCallback,
	encodeMessageInteractionCallback,
	InMemoryMessageInteractionSessionStore,
	type MessageInteractionEffectExecutor,
	type MessageInteractionReceipt,
	MessageInteractionSessionAuthority,
	type MessageInteractionSessionStore,
} from "./sessions";

const choice: ChoiceInteraction = {
	kind: "choice",
	id: "approve-1",
	scope: "approval",
	options: [
		{ value: "approve", label: "Approve" },
		{ value: "deny", label: "Deny" },
	],
};

function profile(template = BUTTON_INTERACTION_PROFILE) {
	return createConnectorInteractionCapabilityProfile({
		template,
		source: "connector",
		accountId: "account-a",
		targetKind: "room",
		targetId: "room-a",
	});
}

const bindings = {
	actorId: "actor-a",
	audience: { kind: "room", id: "room-a" },
	agentId: "agent-a",
	connector: { source: "connector", accountId: "account-a" },
	roomId: "room-a",
	sourceMessageId: "message-a",
};

function receipt(key: string): MessageInteractionReceipt {
	return {
		receiptId: `receipt-${key}`,
		idempotencyKey: key,
		status: "completed",
		completedAt: "2026-08-21T00:00:01.000Z",
		result: { accepted: true },
	};
}

async function created(options?: {
	store?: MessageInteractionSessionStore;
	clock?: () => number;
	preset?: { value: string };
}) {
	const store = options?.store ?? new InMemoryMessageInteractionSessionStore();
	const authority = new MessageInteractionSessionAuthority(store, {
		clock: options?.clock ?? (() => Date.parse("2026-08-21T00:00:00.000Z")),
		referenceFactory: () => "0123456789abcdef0123456789abcdef",
		claimTtlMs: 100,
	});
	const result = await authority.create({
		block: choice,
		profile: profile(),
		bindings,
		purpose: "approval",
		flow: "native",
		...(options?.preset ? { presetResponse: options.preset } : {}),
		authorization: {
			decisionId: "decision-a",
			policyRevision: "policy-7",
			decidedAt: "2026-08-20T23:59:59.000Z",
		},
		effect: { kind: "approve_operation", metadata: { operationId: "op-a" } },
		expiresAt: "2026-08-21T00:10:00.000Z",
	});
	return { authority, store, ...result };
}

describe("connector interaction profiles", () => {
	it("binds IDs to account and target and rejects conflicting registry collisions", () => {
		const a = profile();
		const b = createConnectorInteractionCapabilityProfile({
			template: BUTTON_INTERACTION_PROFILE,
			source: "connector",
			accountId: "account-b",
			targetKind: "room",
			targetId: "room-a",
		});
		expect(a.profileId).not.toBe(b.profileId);
		const registry = new ConnectorInteractionProfileRegistry();
		registry.register(a);
		expect(() =>
			registry.register({ ...b, profileId: a.profileId }),
		).toThrowError(/ID collides/);
	});

	it("requires zero limits for unsupported primitives", () => {
		const invalid = structuredClone(
			profile(CONVERSATIONAL_INTERACTION_PROFILE),
		);
		invalid.limits.modals.maxFields = 1;
		expect(() =>
			normalizeConnectorInteractionCapabilityProfile(invalid),
		).toThrowError(/must be zero/);
	});

	it("uses UTF-8 byte and opaque callback limits before native delivery", () => {
		const constrained = structuredClone(profile());
		constrained.limits.buttons.maxLabelBytes = 7;
		const unicodeChoice = {
			...choice,
			options: [{ value: "ok", label: "✅✅✅" }],
		};
		expect(
			negotiateInteractionDelivery(unicodeChoice, constrained),
		).toMatchObject({
			mode: "conversational",
			reason: "native-limit",
			limitations: ["option label bytes"],
		});
		constrained.limits.buttons.maxLabelBytes = 80;
		constrained.limits.buttons.maxCallbackBytes = 35;
		expect(
			negotiateInteractionDelivery(choice, constrained).limitations,
		).toContain("opaque callback bytes");
	});

	it("checks hosted URL, thread, edit, attachment and form limits", () => {
		const form: FormInteraction = {
			kind: "form",
			id: "upload",
			title: "資料を提出",
			fields: [
				{
					name: "file",
					type: "file",
					maxBytes: 101_000_000,
					mimeTypes: ["application/pdf"],
				},
			],
		};
		const rich = profile(RICH_INTERACTION_PROFILE);
		const result = negotiateInteractionDelivery(form, rich, {
			signedHostedUrl: `https://example.test/${"a".repeat(8_200)}`,
			requiresEdit: true,
			requiresThread: true,
			now: 2_000,
			sourceMessageCreatedAt: 1_000,
		});
		expect(result.limitations).toEqual(["attachment bytes", "link URL bytes"]);
	});

	it("does not apply a hosted-fallback URL limit to a fitting native block", () => {
		expect(
			negotiateInteractionDelivery(choice, profile(), {
				signedHostedUrl: `https://example.test/${"x".repeat(3_000)}`,
			}),
		).toMatchObject({ mode: "native", limitations: [] });
	});
});

describe("message interaction session authority", () => {
	it("property: accepts only canonical opaque callback references", () => {
		let state = 0x24_287;
		const nextByte = () => {
			state = (state * 1_664_525 + 1_013_904_223) >>> 0;
			return state & 0xff;
		};
		for (let sample = 0; sample < 256; sample += 1) {
			const reference = createOpaqueMessageInteractionReference((size) =>
				Uint8Array.from({ length: size }, nextByte),
			);
			const callback = encodeMessageInteractionCallback(reference);
			expect(decodeMessageInteractionCallback(callback)).toBe(reference);
			for (const mutated of [
				callback.toUpperCase(),
				`${callback}0`,
				callback.slice(0, -1),
				callback.replace("is1:", "is2:"),
			]) {
				expect(decodeMessageInteractionCallback(mutated)).toBeNull();
			}
		}
	});

	it("puts only a short opaque reference in callback data", async () => {
		const { callbackData, session } = await created({
			preset: { value: "approve" },
		});
		expect(callbackData).toBe("is1:0123456789abcdef0123456789abcdef");
		expect(decodeMessageInteractionCallback(callbackData)).toBe(
			session.reference,
		);
		expect(callbackData).not.toContain("approve");
		expect(callbackData).not.toContain("account-a");
	});

	it("rejects a requested native flow when the concrete block exceeds limits", async () => {
		const authority = new MessageInteractionSessionAuthority(
			new InMemoryMessageInteractionSessionStore(),
			{ clock: () => Date.parse("2026-08-21T00:00:00.000Z") },
		);
		await expect(
			authority.create({
				block: {
					...choice,
					options: [{ value: "large", label: "x".repeat(81) }],
				},
				profile: profile(),
				bindings,
				purpose: "approval",
				flow: "native",
				authorization: {
					decisionId: "decision-a",
					policyRevision: "policy-a",
					decidedAt: "2026-08-20T23:59:00.000Z",
				},
				effect: { kind: "approve" },
				expiresAt: "2026-08-21T00:05:00.000Z",
			}),
		).rejects.toMatchObject({
			code: "INTERACTION_FLOW_NOT_NEGOTIATED",
			context: expect.objectContaining({
				negotiated: "conversational",
				limitations: ["option label bytes"],
			}),
		});
	});

	it("binds profile text byte limits into custom responses", async () => {
		const store = new InMemoryMessageInteractionSessionStore();
		const authority = new MessageInteractionSessionAuthority(store, {
			clock: () => Date.parse("2026-08-21T00:00:00.000Z"),
			referenceFactory: () => "0123456789abcdef0123456789abcdef",
		});
		const result = await authority.create({
			block: { ...choice, allowCustom: true },
			profile: profile(),
			bindings,
			purpose: "choice",
			flow: "native",
			authorization: {
				decisionId: "decision-a",
				policyRevision: "policy-a",
				decidedAt: "2026-08-20T23:59:00.000Z",
			},
			effect: { kind: "choose" },
			expiresAt: "2026-08-21T00:05:00.000Z",
		});
		await expect(
			authority.consume({
				callbackData: result.callbackData,
				bindings,
				replayKey: "replay-a",
				response: { value: "✅".repeat(1_334) },
				executor: { execute: async () => receipt("replay-a") },
			}),
		).rejects.toMatchObject({ code: "INVALID_MESSAGE_INTERACTION_RESPONSE" });
	});

	it.each([
		["actor", { actorId: "actor-b" }],
		["audience", { audience: { kind: "room", id: "room-b" } }],
		["agent", { agentId: "agent-b" }],
		["account", { connector: { source: "connector", accountId: "account-b" } }],
		["room", { roomId: "room-b" }],
		["source message", { sourceMessageId: "message-b" }],
	])("denies cross-%s callbacks", async (_name, override) => {
		const { authority, callbackData } = await created({
			preset: { value: "approve" },
		});
		await expect(
			authority.consume({
				callbackData,
				bindings: { ...bindings, ...override },
				replayKey: "replay-a",
				executor: { execute: async () => receipt("replay-a") },
			}),
		).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_BINDING_MISMATCH" });
	});

	it("atomically admits one concurrent effect and replays its retained receipt", async () => {
		const { authority, callbackData } = await created({
			preset: { value: "approve" },
		});
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = vi.fn(async () => {
			await gate;
			return receipt("replay-a");
		});
		const executor = { execute };
		const first = authority.consume({
			callbackData,
			bindings,
			replayKey: "replay-a",
			executor,
		});
		await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
		const contenders = await Promise.all(
			Array.from({ length: 20 }, () =>
				authority.consume({
					callbackData,
					bindings,
					replayKey: "replay-a",
					executor,
				}),
			),
		);
		expect(contenders).toEqual(
			Array.from({ length: 20 }, () => ({ status: "in_progress" })),
		);
		release();
		expect(await first).toEqual(receipt("replay-a"));
		expect(
			await authority.consume({
				callbackData,
				bindings,
				replayKey: "replay-a",
				executor,
			}),
		).toEqual(receipt("replay-a"));
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("resumes a crash window with one idempotent effect and completes the receipt", async () => {
		let now = Date.parse("2026-08-21T00:00:00.000Z");
		const backing = new InMemoryMessageInteractionSessionStore();
		let failCompletion = true;
		const crashingStore: MessageInteractionSessionStore = {
			...backing,
			create: backing.create.bind(backing),
			get: backing.get.bind(backing),
			claimIfCurrent: backing.claimIfCurrent.bind(backing),
			revokeAuthorization: backing.revokeAuthorization.bind(backing),
			deleteExpired: backing.deleteExpired.bind(backing),
			completeIfClaimed: async (context) => {
				if (failCompletion) {
					failCompletion = false;
					throw new Error("simulated crash after effect");
				}
				return backing.completeIfClaimed(context);
			},
		};
		const { authority, callbackData } = await created({
			store: crashingStore,
			clock: () => now,
			preset: { value: "approve" },
		});
		const effects = new Map<string, MessageInteractionReceipt>();
		let physicalEffects = 0;
		const executor: MessageInteractionEffectExecutor = {
			execute: async ({ idempotencyKey }) => {
				const prior = effects.get(idempotencyKey);
				if (prior) return prior;
				physicalEffects += 1;
				const value = receipt(idempotencyKey);
				effects.set(idempotencyKey, value);
				return value;
			},
		};
		await expect(
			authority.consume({
				callbackData,
				bindings,
				replayKey: "replay-a",
				executor,
			}),
		).rejects.toThrow("simulated crash");
		now += 101;
		expect(
			await authority.consume({
				callbackData,
				bindings,
				replayKey: "replay-a",
				executor,
			}),
		).toEqual(receipt("replay-a"));
		expect(physicalEffects).toBe(1);
	});

	it("denies tamper, expiry, and revocation after render", async () => {
		let now = Date.parse("2026-08-21T00:00:00.000Z");
		const { authority, store, callbackData, session } = await created({
			clock: () => now,
			preset: { value: "approve" },
		});
		await expect(
			authority.consume({
				callbackData,
				bindings,
				replayKey: "replay-a",
				response: { value: "deny" },
				executor: { execute: async () => receipt("replay-a") },
			}),
		).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_TAMPERED" });
		await store.revokeAuthorization({
			reference: session.reference,
			decisionId: "decision-a",
			now,
		});
		await expect(
			authority.consume({
				callbackData,
				bindings,
				replayKey: "replay-a",
				executor: { execute: async () => receipt("replay-a") },
			}),
		).rejects.toMatchObject({
			code: "MESSAGE_INTERACTION_AUTHORIZATION_REVOKED",
		});

		const second = await created({
			clock: () => now,
			preset: { value: "approve" },
		});
		now = Date.parse("2026-08-21T00:10:00.000Z");
		await expect(
			second.authority.consume({
				callbackData: second.callbackData,
				bindings,
				replayKey: "replay-a",
				executor: { execute: async () => receipt("replay-a") },
			}),
		).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_EXPIRED" });
	});

	it("forbids secrets in ordinary forms and effect metadata", async () => {
		const authority = new MessageInteractionSessionAuthority(
			new InMemoryMessageInteractionSessionStore(),
			{ clock: () => Date.parse("2026-08-21T00:00:00.000Z") },
		);
		const secretForm: FormInteraction = {
			kind: "form",
			id: "bad",
			fields: [{ name: "apiKey", type: "secret" }],
		};
		await expect(
			authority.create({
				block: secretForm,
				profile: profile(RICH_INTERACTION_PROFILE),
				bindings,
				purpose: "auth",
				flow: "native",
				authorization: {
					decisionId: "d",
					policyRevision: "p",
					decidedAt: "2026-08-20T23:59:00.000Z",
				},
				effect: { kind: "setup", metadata: { apiKey: "secret-value" } },
				expiresAt: "2026-08-21T00:05:00.000Z",
			}),
		).rejects.toMatchObject({ code: "INTERACTION_SENSITIVE_FLOW_REQUIRED" });
	});
});
