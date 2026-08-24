/**
 * Behavioral coverage for the message-interaction public barrel — the single
 * entry point `index.node` / `index.browser` / `index.edge` re-export as the
 * `@elizaos/core` interaction surface. Every case drives the real exported
 * runtime through `./index` itself: parse, serialize, callback codecs,
 * session references, response validation, host resolution, capability
 * profiles, delivery negotiation, and the plain-text/dashboard boundaries.
 * Pure deterministic functions; no model, DB, network, or mocks.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import type {
	ChoiceInteraction,
	Content,
	FormInteraction,
	SecretInteraction,
} from "../../types";
import * as interactions from "./index";

function errorCode(thrown: unknown): string | undefined {
	return thrown instanceof ElizaError ? thrown.code : undefined;
}

describe("barrel: parse ↔ serialize wire round trip", () => {
	const reply =
		"Ship it?\n[CHOICE:release id=r1 allow_custom]\nyes=Ship\nno=Hold\n[/CHOICE]";

	it("parses a choice block through the barrel and preserves document prose", () => {
		const { blocks, cleanedText } = interactions.parseInteractionBlocks(reply);
		expect(blocks).toHaveLength(1);
		const choice = blocks[0] as ChoiceInteraction;
		expect(choice.kind).toBe("choice");
		expect(choice.scope).toBe("release");
		expect(choice.id).toBe("r1");
		expect(choice.allowCustom).toBe(true);
		expect(choice.options).toEqual([
			{ value: "yes", label: "Ship" },
			{ value: "no", label: "Hold" },
		]);
		expect(cleanedText).toBe("Ship it?");
		expect(interactions.hasInteractionBlocks(reply)).toBe(true);
		expect(interactions.hasInteractionBlocks("plain answer")).toBe(false);
	});

	it("serializes back to wire form that reparses identically", () => {
		const { blocks } = interactions.parseInteractionBlocks(reply);
		const serialized = interactions.serializeInteractionBlock(blocks[0]);
		expect(serialized).toBe(
			"[CHOICE:release id=r1 allow_custom]\nyes=Ship\nno=Hold\n[/CHOICE]",
		);
		const reparsed = interactions.parseInteractionBlocks(serialized);
		expect(reparsed.blocks[0]).toEqual(blocks[0]);
	});

	it("caps a form at MAX_FORM_FIELDS and drops unknown field types", () => {
		const fields = Array.from({ length: 25 }, (_, i) => ({
			name: `f${i}`,
			type: i === 24 ? "color" : "text",
		}));
		const { blocks } = interactions.parseInteractionBlocks(
			`[FORM]\n${JSON.stringify({ title: "Login", fields })}\n[/FORM]`,
		);
		const form = blocks[0] as FormInteraction;
		expect(interactions.MAX_FORM_FIELDS).toBe(20);
		expect(form.fields.map((f) => f.name)).toEqual(
			Array.from({ length: 20 }, (_, i) => `f${i}`),
		);
		expect(form.submitLabel).toBe("Submit");
	});

	it("gives secret blocks no text form and leaves appendInteractionBlock untouched by them", () => {
		const secret: SecretInteraction = {
			kind: "secret",
			id: "s1",
			secretKind: "secret",
		};
		expect(interactions.serializeInteractionBlock(secret)).toBe("");
		expect(interactions.appendInteractionBlock("Hello", secret)).toBe("Hello");
	});
});

describe("barrel: reply callback codec", () => {
	it("encodes, recognizes, and decodes a tapped answer", () => {
		const data = interactions.encodeReplyCallback("yes");
		expect(data).toBe("ia1:yes");
		expect(interactions.isInteractionCallback(data)).toBe(true);
		expect(interactions.decodeCallback(data)).toEqual({
			kind: "reply",
			value: "yes",
		});
	});

	it("returns null past the platform byte budget instead of truncating", () => {
		const big = "x".repeat(interactions.MAX_CALLBACK_BYTES);
		expect(interactions.encodeReplyCallback(big)).toBeNull();
		expect(
			interactions.encodeReplyCallback(big.slice(1), { maxBytes: 100 }),
		).toBe(`ia1:${"x".repeat(63)}`);
	});

	it("ignores foreign payloads", () => {
		expect(interactions.isInteractionCallback(undefined)).toBe(false);
		expect(interactions.decodeCallback("discord:somethingelse")).toBeNull();
		expect(interactions.decodeCallback(42)).toBeNull();
	});
});

describe("barrel: opaque session references", () => {
	it("hexes the injected entropy into a 128-bit reference", () => {
		const reference = interactions.createOpaqueMessageInteractionReference(() =>
			new Uint8Array(16).fill(7),
		);
		expect(reference).toBe("07".repeat(16));
	});

	it("encodes and decodes through the is1: prefix at the documented wire size", () => {
		const reference = "ab".repeat(16);
		const encoded = interactions.encodeMessageInteractionCallback(reference);
		expect(encoded).toBe(
			`${interactions.MESSAGE_INTERACTION_CALLBACK_PREFIX}${reference}`,
		);
		expect(encoded).toHaveLength(
			interactions.MESSAGE_INTERACTION_CALLBACK_BYTES,
		);
		expect(interactions.decodeMessageInteractionCallback(encoded)).toBe(
			reference,
		);
	});

	it("rejects non-opaque references on encode and foreign payloads on decode", () => {
		let thrown: unknown;
		try {
			interactions.encodeMessageInteractionCallback("NOT-A-REFERENCE");
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INVALID_MESSAGE_INTERACTION_REFERENCE");

		expect(interactions.decodeMessageInteractionCallback(null)).toBeNull();
		expect(
			interactions.decodeMessageInteractionCallback("is1:NOTHEX"),
		).toBeNull();
		expect(
			interactions.decodeMessageInteractionCallback("ia1:short"),
		).toBeNull();
	});
});

describe("barrel: response schemas and validation", () => {
	it("derives the accepted shape from a fixed choice and accepts a valid answer", () => {
		const choice: ChoiceInteraction = {
			kind: "choice",
			id: "r1",
			scope: "release",
			options: [
				{ value: "yes", label: "Ship" },
				{ value: "no", label: "Hold" },
			],
		};
		const schema = interactions.responseSchemaForInteraction(choice);
		expect(schema.additionalFields).toBe(false);
		expect(schema.fields[0]).toMatchObject({
			name: "value",
			type: "text",
			required: true,
			options: ["yes", "no"],
		});
		expect(
			interactions.validateMessageInteractionResponse({ value: "yes" }, schema),
		).toEqual({ value: "yes" });
	});

	it("omits the option list when the choice allows custom answers", () => {
		const schema = interactions.responseSchemaForInteraction({
			kind: "choice",
			id: "r1",
			scope: "release",
			allowCustom: true,
			options: [{ value: "yes", label: "Ship" }],
		});
		expect(schema.fields[0].options).toBeUndefined();
	});

	it("rejects unknown options, unexpected fields, and missing required fields", () => {
		const choice: ChoiceInteraction = {
			kind: "choice",
			id: "r1",
			scope: "release",
			options: [{ value: "yes", label: "Ship" }],
		};
		const schema = interactions.responseSchemaForInteraction(choice);

		let thrown: unknown;
		try {
			interactions.validateMessageInteractionResponse(
				{ value: "maybe" },
				schema,
			);
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INVALID_MESSAGE_INTERACTION_RESPONSE");

		expect(() =>
			interactions.validateMessageInteractionResponse(
				{ value: "yes", extra: 1 },
				schema,
			),
		).toThrow(/Unexpected interaction response field: extra/);

		expect(() =>
			interactions.validateMessageInteractionResponse({}, schema),
		).toThrow(/Missing interaction response field: value/);
	});

	it("requires a boolean acknowledgement for task blocks", () => {
		const schema = interactions.responseSchemaForInteraction({
			kind: "task",
			threadId: "t1",
			title: "Ship",
		});
		expect(schema.fields[0]).toMatchObject({
			name: "acknowledged",
			type: "acknowledgement",
			required: true,
		});
		expect(
			interactions.validateMessageInteractionResponse(
				{ acknowledged: true },
				schema,
			),
		).toEqual({ acknowledged: true });

		let thrown: unknown;
		try {
			interactions.validateMessageInteractionResponse(
				{ acknowledged: "yes" },
				schema,
			);
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INVALID_MESSAGE_INTERACTION_RESPONSE");
	});

	it("refuses to derive a persisted schema for forms carrying secret fields", () => {
		let thrown: unknown;
		try {
			interactions.responseSchemaForInteraction({
				kind: "form",
				id: "f1",
				fields: [{ name: "apiKey", type: "secret" }],
			});
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INTERACTION_SENSITIVE_FLOW_REQUIRED");
	});
});

describe("barrel: host resolution", () => {
	function runtimeReturning(service: unknown) {
		return {
			getService: (name: string) =>
				name === interactions.MESSAGE_INTERACTION_HOST_SERVICE
					? service
					: undefined,
		} as Parameters<typeof interactions.resolveMessageInteractionHost>[0];
	}

	const wellFormed = {
		prepare: () => {},
		consume: () => {},
		revoke: () => {},
		get: () => {},
		registerEffectHandler: () => () => {},
	};

	it("returns null when no host service is registered", () => {
		expect(
			interactions.resolveMessageInteractionHost(runtimeReturning(undefined)),
		).toBeNull();
	});

	it("throws a typed error for a malformed registration", () => {
		let thrown: unknown;
		try {
			interactions.resolveMessageInteractionHost(
				runtimeReturning({ prepare: () => {} }),
			);
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INVALID_MESSAGE_INTERACTION_HOST_SERVICE");
	});

	it("passes a well-formed host through", () => {
		expect(
			interactions.resolveMessageInteractionHost(runtimeReturning(wellFormed)),
		).toBe(wellFormed);
	});
});

describe("barrel: capability profiles and delivery negotiation", () => {
	const buttonProfile =
		interactions.createConnectorInteractionCapabilityProfile({
			template: interactions.BUTTON_INTERACTION_PROFILE,
			source: "testconn",
			accountId: "acct-1",
			targetKind: "room",
			targetId: "room-1",
		});

	it("prefers native delivery for a choice a button platform can carry", () => {
		const delivery = interactions.negotiateInteractionDelivery(
			{
				kind: "choice",
				id: "r1",
				scope: "release",
				options: [
					{ value: "yes", label: "Ship" },
					{ value: "no", label: "Hold" },
				],
			},
			buttonProfile,
		);
		expect(delivery).toEqual({
			mode: "native",
			reason: "preferred",
			limitations: [],
		});
	});

	it("falls back to conversational delivery when no native primitive exists", () => {
		const conversationalProfile =
			interactions.createConnectorInteractionCapabilityProfile({
				template: interactions.CONVERSATIONAL_INTERACTION_PROFILE,
				source: "testconn",
				accountId: "acct-1",
				targetKind: "email",
				targetId: "inbox-1",
			});
		const delivery = interactions.negotiateInteractionDelivery(
			{
				kind: "choice",
				id: "r1",
				scope: "release",
				options: [{ value: "yes", label: "Ship" }],
			},
			conversationalProfile,
		);
		expect(delivery.mode).toBe("conversational");
		expect(delivery.reason).toBe("native-unavailable");
		expect(delivery.limitations).toEqual(["no native choice primitive"]);
	});

	it("routes secret blocks exclusively through the sensitive-request flow", () => {
		expect(
			interactions.negotiateInteractionDelivery(
				{ kind: "secret", id: "s1", secretKind: "oauth" },
				buttonProfile,
			),
		).toEqual({
			mode: "sensitive-request",
			reason: "sensitive",
			limitations: [],
		});
	});

	it("refuses ordinary forms that smuggle secret fields", () => {
		let thrown: unknown;
		try {
			interactions.negotiateInteractionDelivery(
				{
					kind: "form",
					id: "f1",
					fields: [{ name: "apiKey", type: "secret" }],
				},
				buttonProfile,
			);
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INTERACTION_SENSITIVE_FLOW_REQUIRED");
	});

	it("rejects colliding profile IDs with a different account or target body", () => {
		const registry = new interactions.ConnectorInteractionProfileRegistry();
		const stored = registry.register(buttonProfile);
		expect(registry.register(buttonProfile)).toEqual(stored);

		let thrown: unknown;
		try {
			registry.register({
				...stored,
				connector: { ...stored.connector, accountId: "acct-2" },
			});
		} catch (error) {
			thrown = error;
		}
		expect(errorCode(thrown)).toBe("INTERACTION_PROFILE_ID_COLLISION");

		expect(registry.get(stored.profileId)).toEqual(stored);
		expect(registry.get("ip1:none")).toBeNull();
	});
});

describe("barrel: outbound text boundaries", () => {
	it("attaches parsed blocks to content without mutating the prose", () => {
		const reply =
			"Ship it?\n[CHOICE:release id=r1]\nyes=Ship\nno=Hold\n[/CHOICE]";
		const normalized: Content = interactions.normalizeContentInteractions({
			text: reply,
		});
		expect(normalized.interactions).toHaveLength(1);
		expect(normalized.text).toBe(reply);

		expect(interactions.stripInteractionMarkers(reply)).toBe("Ship it?");
	});

	it("renders a connector-safe plain-text projection of the choice", () => {
		const rendered = interactions.renderInteractionsAsPlainText(
			"Ship it?\n[CHOICE:release id=r1]\nyes=Ship\nno=Hold\n[/CHOICE]",
		);
		expect(rendered.hadBlocks).toBe(true);
		expect(rendered.text).toContain("Ship it?");
		expect(rendered.text).toContain("Ship");
		expect(rendered.text).toContain("Hold");
		expect(rendered.text).not.toContain("[CHOICE]");
		expect(rendered.text).not.toContain("yes=");
	});

	it("removes dashboard-only markers from connector text", () => {
		expect(
			interactions.stripDashboardOnlyMarkers(
				"You'll need Google Calendar first.\n\n[CONFIG:google_calendars]\n\nThen I can list events.",
			),
		).toBe("You'll need Google Calendar first.\n\nThen I can list events.");
	});

	it("lays out choice options into callback-carrying button rows", () => {
		const layout = interactions.toNeutralLayout({
			kind: "choice",
			id: "r1",
			scope: "release",
			prompt: "Ship it?",
			options: [
				{ value: "yes", label: "Ship" },
				{ value: "no", label: "Hold" },
				{ value: "wait", label: "Wait" },
				{ value: "ask", label: "Ask" },
			],
		});
		expect(layout.text).toBe("Ship it?");
		expect(layout.rows).toHaveLength(2);
		expect(layout.rows[0]?.buttons?.map((b) => b.label)).toEqual([
			"Ship",
			"Hold",
			"Wait",
		]);
		expect(layout.rows[1]?.buttons?.map((b) => b.label)).toEqual(["Ask"]);
		expect(
			interactions.decodeCallback(layout.rows[1]?.buttons?.[0]?.callbackData),
		).toEqual({ kind: "reply", value: "ask" });
		expect(layout.needsFallback).toBe(false);

		const resolver =
			interactions.buildInteractionUrlResolver("https://app.test/");
		expect(
			resolver.resolveUrl?.({ kind: "task", threadId: "t9", title: "Ship" }),
		).toBe("https://app.test/orchestrator?taskId=t9");
	});
});
