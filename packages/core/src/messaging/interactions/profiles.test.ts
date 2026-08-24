/**
 * Exercises the connector interaction capability profiles in profiles.ts:
 * validation and defensive copying, deterministic profile-ID minting, delivery
 * negotiation across native / signed-hosted / conversational modes (including
 * secret handling and every unsafe-URL gate), the collision-checking profile
 * registry, and the reviewer-facing capability matrix. Pure and deterministic —
 * no connectors, no network.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import type {
	InteractionBlock,
	InteractionBlockCapability,
	InteractionKind,
} from "../../types/interactions";
import {
	type ConnectorInteractionCapabilityProfile,
	ConnectorInteractionProfileRegistry,
	createConnectorInteractionCapabilityProfile,
	INTERACTION_PROFILE_VERSION,
	type InteractionPrimitiveLimits,
	negotiateInteractionDelivery,
	normalizeConnectorInteractionCapabilityProfile,
	renderInteractionCapabilityMatrix,
} from "./profiles";

const TTL = 86_400_000;

function blocks(
	overrides: Partial<Record<InteractionKind, InteractionBlockCapability>> = {},
): Record<InteractionKind, InteractionBlockCapability> {
	return {
		choice: { modes: ["native", "conversational"], maxSessionTtlMs: TTL },
		form: { modes: ["conversational"], maxSessionTtlMs: TTL },
		followups: { modes: ["native", "conversational"], maxSessionTtlMs: TTL },
		task: { modes: ["signed-hosted", "conversational"], maxSessionTtlMs: TTL },
		secret: { modes: ["sensitive-request"], maxSessionTtlMs: 600_000 },
		...overrides,
	};
}

const BASE_LIMITS: InteractionPrimitiveLimits = {
	buttons: {
		supported: true,
		maxPerRow: 5,
		maxPerMessage: 20,
		maxLabelBytes: 64,
		maxCallbackBytes: 1024,
	},
	lists: {
		supported: true,
		maxItems: 10,
		maxLabelBytes: 128,
		maxDescriptionBytes: 256,
	},
	modals: { supported: true, maxFields: 10, maxTitleBytes: 100 },
	forms: { supported: true, maxFields: 10, maxOptionsPerField: 10 },
	links: { supported: true, maxUrlBytes: 2048 },
	edits: { supported: false, windowMs: null },
	threads: { supported: true, maxTitleBytes: 100 },
	text: { maxMessageBytes: 4096 },
	attachments: {
		supported: true,
		maxCount: 3,
		maxBytesEach: 8_000_000,
		mimeTypes: ["*/*"],
	},
};

function limits(
	patch: (base: InteractionPrimitiveLimits) => InteractionPrimitiveLimits = (
		b,
	) => b,
): InteractionPrimitiveLimits {
	return patch(structuredClone(BASE_LIMITS));
}

function validProfile(
	patch: {
		blocks?: Partial<Record<InteractionKind, InteractionBlockCapability>>;
		limits?: (base: InteractionPrimitiveLimits) => InteractionPrimitiveLimits;
		nonSecretFallbacks?: ConnectorInteractionCapabilityProfile["nonSecretFallbacks"];
	} = {},
): ConnectorInteractionCapabilityProfile {
	return {
		profileVersion: INTERACTION_PROFILE_VERSION,
		profileId: "ip1:test-profile",
		connector: { source: "telegram", accountId: "acct-1" },
		target: { kind: "chat", id: "room-1" },
		blocks: blocks(patch.blocks),
		limits: limits(patch.limits),
		nonSecretFallbacks: patch.nonSecretFallbacks ?? [
			"native",
			"conversational",
			"signed-hosted",
		],
		sensitiveFallback: "sensitive-request",
	};
}

function ordinaryOnlyProfile(
	mode: "native" | "conversational" | "signed-hosted",
	limitsPatch?: (
		base: InteractionPrimitiveLimits,
	) => InteractionPrimitiveLimits,
): ConnectorInteractionCapabilityProfile {
	const ordinaryBlocks = Object.fromEntries(
		(["choice", "form", "followups", "task"] as const).map((kind) => [
			kind,
			{ modes: [mode], maxSessionTtlMs: TTL },
		]),
	) as Partial<Record<InteractionKind, InteractionBlockCapability>>;
	return validProfile({
		blocks: ordinaryBlocks,
		nonSecretFallbacks: [mode],
		limits: limitsPatch,
	});
}

function expectInvalid(
	fn: () => unknown,
	messageIncludes?: string,
): ElizaError {
	let caught: unknown;
	try {
		fn();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ElizaError);
	const error = caught as ElizaError;
	expect(error.code).toBe("INVALID_INTERACTION_CAPABILITY_PROFILE");
	if (messageIncludes) {
		expect(error.message).toContain(messageIncludes);
	}
	return error;
}

const choice = (optionCount: number): InteractionBlock => ({
	kind: "choice",
	id: "c1",
	scope: "schedule",
	options: Array.from({ length: optionCount }, (_, i) => ({
		value: `opt-${i}`,
		label: `Option ${i}`,
	})),
});

describe("normalizeConnectorInteractionCapabilityProfile", () => {
	it("accepts a complete profile and returns a defensively copied one with trimmed identifiers", () => {
		const input = validProfile();
		input.profileId = "  ip1:padded-id  ";
		input.connector.accountId = "  acct-trim  ";

		const normalized = normalizeConnectorInteractionCapabilityProfile(input);

		expect(normalized.profileId).toBe("ip1:padded-id");
		expect(normalized.connector.accountId).toBe("acct-trim");
		expect(normalized).not.toBe(input);
		normalized.blocks.choice.modes = [];
		expect(input.blocks.choice.modes.length).toBe(2);
	});

	it("rejects wrong versions, omitted or empty-mode blocks, unknown and repeated modes", () => {
		const wrongVersion = validProfile();
		(wrongVersion as { profileVersion: number }).profileVersion = 99;
		expectInvalid(() =>
			normalizeConnectorInteractionCapabilityProfile(wrongVersion),
		);

		const missing = validProfile();
		delete (missing.blocks as Record<string, unknown>).choice;
		expectInvalid(
			() => normalizeConnectorInteractionCapabilityProfile(missing),
			"omits choice",
		);

		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: { form: { modes: [], maxSessionTtlMs: TTL } },
					}),
				),
			"omits form",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: {
							form: {
								modes: ["telepathy" as "conversational"],
								maxSessionTtlMs: TTL,
							},
						},
					}),
				),
			"unknown form mode",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: {
							followups: {
								modes: ["native", "native"],
								maxSessionTtlMs: TTL,
							},
						},
					}),
				),
			"repeats a followups mode",
		);
	});

	it("confines sensitive-request to secret blocks and vice versa", () => {
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: {
							choice: {
								modes: ["sensitive-request"],
								maxSessionTtlMs: TTL,
							},
						},
					}),
				),
			"Ordinary interaction blocks cannot use the sensitive-request mode",
		);
	});

	it("rejects a secret block that declares any flow other than sensitive-request", () => {
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: { secret: { modes: ["native"], maxSessionTtlMs: TTL } },
					}),
				).blocks.secret.modes,
		);
	});

	it("enforces supported primitives to be positive integers and unsupported ones to be zero", () => {
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						limits: (b) => ({
							...b,
							buttons: { ...b.buttons, supported: false },
						}),
					}),
				),
			"limits.buttons.maxPerRow must be zero when unsupported",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						limits: (b) => ({
							...b,
							buttons: {
								...b.buttons,
								supported: false,
								maxPerRow: 0,
								maxPerMessage: 0,
								maxLabelBytes: 0,
								maxCallbackBytes: 0,
							},
							lists: { ...b.lists, supported: true, maxItems: 0 },
						}),
					}),
				),
			"limits.lists.maxItems must be a positive safe integer",
		);
	});

	it("validates edit windows against support and declared values", () => {
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						limits: (b) => ({
							...b,
							edits: { supported: false, windowMs: 5_000 },
						}),
					}),
				),
			"Unsupported edits must not declare a time window",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						limits: (b) => ({ ...b, edits: { supported: true, windowMs: 0 } }),
					}),
				),
			"limits.edits.windowMs is invalid",
		);
	});

	it("rejects attachment declarations on unsupported attachments and incoherent native choices", () => {
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						limits: (b) => ({
							...b,
							attachments: {
								supported: false,
								maxCount: 0,
								maxBytesEach: 0,
								mimeTypes: ["image/png"],
							},
						}),
					}),
				),
			"Unsupported attachments cannot declare MIME types",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: { choice: { modes: ["native"], maxSessionTtlMs: TTL } },
						nonSecretFallbacks: ["native"],
						limits: (b) => ({
							...b,
							buttons: {
								...b.buttons,
								supported: false,
								maxPerRow: 0,
								maxPerMessage: 0,
								maxLabelBytes: 0,
								maxCallbackBytes: 0,
							},
							lists: {
								...b.lists,
								supported: false,
								maxItems: 0,
								maxLabelBytes: 0,
								maxDescriptionBytes: 0,
							},
						}),
					}),
				),
			"Native choices require buttons or lists",
		);
	});

	it("requires unique known non-secret fallbacks covering every declared ordinary block mode", () => {
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({ nonSecretFallbacks: [] }),
				),
			"A non-secret fallback is required",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({ nonSecretFallbacks: ["native", "native"] }),
				),
			"must be unique known modes",
		);
		expectInvalid(
			() =>
				normalizeConnectorInteractionCapabilityProfile(
					validProfile({
						blocks: {
							choice: { modes: ["conversational"], maxSessionTtlMs: TTL },
							form: { modes: ["conversational"], maxSessionTtlMs: TTL },
							followups: { modes: ["conversational"], maxSessionTtlMs: TTL },
							task: { modes: ["signed-hosted"], maxSessionTtlMs: TTL },
						},
						nonSecretFallbacks: ["conversational"],
					}),
				),
			"task declares a mode missing from non-secret fallbacks",
		);
	});
});

describe("createConnectorInteractionCapabilityProfile", () => {
	it("mints a stable ip1 profile id for identical inputs and distinct ids per target", () => {
		const args = {
			template: {
				templateId: "team-standard",
				blocks: blocks(),
				limits: limits(),
				nonSecretFallbacks: ["native", "conversational", "signed-hosted"],
			},
			source: "discord",
			accountId: "guild-7",
			targetKind: "channel",
			targetId: "chan-1",
		} as const;

		const first = createConnectorInteractionCapabilityProfile(args);
		const second = createConnectorInteractionCapabilityProfile(args);
		expect(first.profileId).toMatch(/^ip1:/);
		expect(first.profileId).toBe(second.profileId);
		expect(first.sensitiveFallback).toBe("sensitive-request");

		const otherTarget = createConnectorInteractionCapabilityProfile({
			...args,
			targetId: "chan-2",
		});
		expect(otherTarget.profileId).not.toBe(first.profileId);
	});
});

describe("negotiateInteractionDelivery", () => {
	it("routes secret blocks to the sensitive-request flow regardless of profile modes", () => {
		const decision = negotiateInteractionDelivery(
			{ kind: "secret", id: "s1", secretKind: "oauth", provider: "GitHub" },
			validProfile(),
		);
		expect(decision.mode).toBe("sensitive-request");
		expect(decision.reason).toBe("sensitive");
		expect(decision.limitations).toEqual([]);
	});

	it("refuses forms that carry secret fields instead of downgrading them", () => {
		let caught: unknown;
		try {
			negotiateInteractionDelivery(
				{
					kind: "form",
					id: "f1",
					fields: [{ name: "api_key", type: "secret" }],
				},
				validProfile({
					blocks: { form: { modes: ["conversational"], maxSessionTtlMs: TTL } },
				}),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(
			"INTERACTION_SENSITIVE_FLOW_REQUIRED",
		);
	});

	it("prefers native when the payload fits the declared primitive limits", () => {
		const decision = negotiateInteractionDelivery(choice(3), validProfile());
		expect(decision.mode).toBe("native");
		expect(decision.reason).toBe("preferred");
		expect(decision.limitations).toEqual([]);
	});

	it("falls back to conversational with recorded limitations when native limits are exceeded", () => {
		const decision = negotiateInteractionDelivery(choice(25), validProfile());
		expect(decision.mode).toBe("conversational");
		expect(decision.reason).toBe("native-limit");
		expect(decision.limitations).toContain("option count");
	});

	it("uses signed hosting only for verified https URLs without credentials or fragments", () => {
		const task = {
			kind: "task",
			threadId: "t1",
			title: "Deploy",
		} as InteractionBlock;
		const profile = ordinaryOnlyProfile("signed-hosted");

		const unavailable = (() => {
			try {
				return negotiateInteractionDelivery(task, profile);
			} catch (error) {
				return error as ElizaError;
			}
		})();
		expect((unavailable as ElizaError).context).toMatchObject({
			limitations: expect.arrayContaining(["signed hosted URL unavailable"]),
		});

		const unverified = (() => {
			try {
				return negotiateInteractionDelivery(task, profile, {
					signedHostedUrl: "https://tasks.example.com/t1?sig=abc",
					signedHostedUrlVerified: false,
				});
			} catch (error) {
				return error as ElizaError;
			}
		})();
		expect((unverified as ElizaError).context).toMatchObject({
			limitations: expect.arrayContaining(["signed hosted URL unverified"]),
		});

		const insecure = (() => {
			try {
				return negotiateInteractionDelivery(task, profile, {
					signedHostedUrl: "http://tasks.example.com/t1",
					signedHostedUrlVerified: true,
				});
			} catch (error) {
				return error as ElizaError;
			}
		})();
		expect((insecure as ElizaError).context).toMatchObject({
			limitations: expect.arrayContaining(["signed hosted URL unsafe"]),
		});

		const credentialed = (() => {
			try {
				return negotiateInteractionDelivery(task, profile, {
					signedHostedUrl: "https://user:pass@tasks.example.com/t1#frag",
					signedHostedUrlVerified: true,
				});
			} catch (error) {
				return error as ElizaError;
			}
		})();
		expect((credentialed as ElizaError).context).toMatchObject({
			limitations: expect.arrayContaining(["signed hosted URL unsafe"]),
		});

		const hosted = negotiateInteractionDelivery(task, profile, {
			signedHostedUrl: "https://tasks.example.com/t1?sig=abc",
			signedHostedUrlVerified: true,
		});
		expect(hosted.mode).toBe("signed-hosted");
		expect(hosted.reason).toBe("native-unavailable");
		expect(hosted.limitations).toEqual([]);
	});

	it("fails closed when no configured mode can carry the payload", () => {
		let caught: unknown;
		try {
			negotiateInteractionDelivery(
				choice(25),
				ordinaryOnlyProfile("conversational", (b) => ({
					...b,
					text: { maxMessageBytes: 10 },
				})),
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		const error = caught as ElizaError;
		expect(error.code).toBe("INTERACTION_DELIVERY_UNAVAILABLE");
		expect(error.context).toMatchObject({
			limitations: expect.arrayContaining(["option count", "message bytes"]),
			profileId: "ip1:test-profile",
		});
	});
});

describe("ConnectorInteractionProfileRegistry", () => {
	it("stores by profile id, hands out copies, and rejects collisions from different bodies", () => {
		const registry = new ConnectorInteractionProfileRegistry();
		const profile = createConnectorInteractionCapabilityProfile({
			template: {
				templateId: "std",
				blocks: blocks(),
				limits: limits(),
				nonSecretFallbacks: ["native", "conversational", "signed-hosted"],
			},
			source: "slack",
			accountId: "ws-1",
			targetKind: "channel",
			targetId: "ch-1",
		});

		const registered = registry.register(profile);
		registered.target.id = "mutated";
		expect(registry.get(profile.profileId)?.target.id).toBe("ch-1");

		expect(registry.register(profile).profileId).toBe(profile.profileId);
		expect(registry.get("ip1:missing")).toBeNull();

		const impostor = structuredClone(profile);
		impostor.target.id = "ch-999";
		expect(() => registry.register(impostor)).toThrowError(/collides/);
		try {
			registry.register(impostor);
		} catch (error) {
			expect((error as ElizaError).code).toBe(
				"INTERACTION_PROFILE_ID_COLLISION",
			);
		}
	});
});

describe("renderInteractionCapabilityMatrix", () => {
	it("renders a deterministic sorted markdown matrix with header and per-profile rows", () => {
		const make = (source: string, accountId: string, targetId: string) =>
			createConnectorInteractionCapabilityProfile({
				template: {
					templateId: "std",
					blocks: blocks(),
					limits: limits(),
					nonSecretFallbacks: ["native", "conversational", "signed-hosted"],
				},
				source,
				accountId,
				targetKind: "channel",
				targetId,
			});
		const zeta = make("telegram", "acct-z", "room-z");
		const alpha = make("discord", "acct-a", "chan-a");

		const matrix = renderInteractionCapabilityMatrix([zeta, alpha]);
		const lines = matrix.split("\n");
		expect(lines[0]).toBe(
			"| Connector | Account | Target | Block delivery | Callback bytes | Attachments |",
		);
		expect(lines[1]).toContain("---");
		expect(lines[2]).toContain("| discord | acct-a | channel:chan-a |");
		expect(lines[3]).toContain("| telegram | acct-z | channel:room-z |");
		expect(lines[2]).toContain("secret:sensitive-request");
		expect(matrix).toContain("| 1024 |");
		expect(renderInteractionCapabilityMatrix([zeta])).toBe(
			renderInteractionCapabilityMatrix([zeta]),
		);
	});
});
