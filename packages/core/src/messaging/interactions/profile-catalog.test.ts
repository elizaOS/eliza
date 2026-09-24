/**
 * Exercises real interaction profile materialization and catalog invariants.
 * The filesystem-backed profile matrix suite owns generated Markdown output.
 */

import { describe, expect, it } from "vitest";
import {
	BUTTON_INTERACTION_PROFILE,
	CONVERSATIONAL_INTERACTION_PROFILE,
	FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT,
	RICH_INTERACTION_PROFILE,
	renderFirstPartyInteractionCapabilityMatrix,
} from "./profile-catalog";
import * as profiles from "./profiles";

const CONVERSATIONAL_TTL_MS = 900_000;
const TASK_TTL_MS = 21_600_000;

describe("CONVERSATIONAL_INTERACTION_PROFILE", () => {
	it("declares the conversational-v1 template id and ordered block modes", () => {
		expect(CONVERSATIONAL_INTERACTION_PROFILE.templateId).toBe(
			"conversational-v1",
		);
		expect(CONVERSATIONAL_INTERACTION_PROFILE.blocks.choice).toEqual({
			modes: ["conversational", "signed-hosted"],
			maxSessionTtlMs: CONVERSATIONAL_TTL_MS,
		});
		expect(CONVERSATIONAL_INTERACTION_PROFILE.blocks.form).toEqual({
			modes: ["conversational", "signed-hosted"],
			maxSessionTtlMs: CONVERSATIONAL_TTL_MS,
		});
		expect(CONVERSATIONAL_INTERACTION_PROFILE.blocks.followups).toEqual({
			modes: ["conversational"],
			maxSessionTtlMs: CONVERSATIONAL_TTL_MS,
		});
		expect(CONVERSATIONAL_INTERACTION_PROFILE.blocks.task).toEqual({
			modes: ["signed-hosted", "conversational"],
			maxSessionTtlMs: TASK_TTL_MS,
		});
		expect(CONVERSATIONAL_INTERACTION_PROFILE.blocks.secret).toEqual({
			modes: ["sensitive-request"],
			maxSessionTtlMs: CONVERSATIONAL_TTL_MS,
		});
	});

	it("uses a 15-minute session TTL everywhere except the 6-hour task block", () => {
		expect(CONVERSATIONAL_TTL_MS).toBe(15 * 60 * 1_000);
		expect(TASK_TTL_MS).toBe(24 * CONVERSATIONAL_TTL_MS);
		expect(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks.choice.maxSessionTtlMs,
		).toBe(900_000);
		expect(CONVERSATIONAL_INTERACTION_PROFILE.blocks.task.maxSessionTtlMs).toBe(
			21_600_000,
		);
	});

	it("disables every native primitive except links and bounds text at 4,000 bytes", () => {
		expect(CONVERSATIONAL_INTERACTION_PROFILE.limits).toEqual({
			buttons: {
				supported: false,
				maxPerRow: 0,
				maxPerMessage: 0,
				maxLabelBytes: 0,
				maxCallbackBytes: 0,
			},
			lists: {
				supported: false,
				maxItems: 0,
				maxLabelBytes: 0,
				maxDescriptionBytes: 0,
			},
			modals: { supported: false, maxFields: 0, maxTitleBytes: 0 },
			forms: { supported: false, maxFields: 0, maxOptionsPerField: 0 },
			links: { supported: true, maxUrlBytes: 2_048 },
			edits: { supported: false, windowMs: null },
			threads: { supported: false, maxTitleBytes: 0 },
			text: { maxMessageBytes: 4_000 },
			attachments: {
				supported: false,
				maxCount: 0,
				maxBytesEach: 0,
				mimeTypes: [],
			},
		});
	});

	it("orders non-secret fallbacks conversational before signed-hosted", () => {
		expect(CONVERSATIONAL_INTERACTION_PROFILE.nonSecretFallbacks).toEqual([
			"conversational",
			"signed-hosted",
		]);
	});

	it("materializes into a valid version-1 capability profile", () => {
		const materialized = profiles.createConnectorInteractionCapabilityProfile({
			template: CONVERSATIONAL_INTERACTION_PROFILE,
			source: "imessage",
			accountId: "acct-conversational",
			targetKind: "user",
			targetId: "target-conversational",
		});
		expect(materialized.profileVersion).toBe(1);
		expect(materialized.connector).toEqual({
			source: "imessage",
			accountId: "acct-conversational",
		});
		expect(materialized.target).toEqual({
			kind: "user",
			id: "target-conversational",
		});
		expect(materialized.profileId).toMatch(/^ip1:/);
		expect(materialized.limits).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits,
		);
		expect(materialized.nonSecretFallbacks).toEqual([
			"conversational",
			"signed-hosted",
		]);
		expect(materialized.sensitiveFallback).toBe("sensitive-request");
	});
});

describe("BUTTON_INTERACTION_PROFILE", () => {
	it("keeps the conversational defaults it does not override", () => {
		expect(BUTTON_INTERACTION_PROFILE.templateId).toBe("button-native-v1");
		expect(BUTTON_INTERACTION_PROFILE.blocks.form).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks.form,
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks.secret).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks.secret,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.links).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.links,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.text).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.text,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.edits).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.edits,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.lists).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.lists,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.modals).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.modals,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.forms).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.forms,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.threads).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.threads,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.attachments).toEqual(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.attachments,
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks.task.maxSessionTtlMs).toBe(
			TASK_TTL_MS,
		);
	});

	it("prepends native to exactly choice, followups, and task", () => {
		expect(BUTTON_INTERACTION_PROFILE.blocks.choice.modes).toEqual([
			"native",
			"conversational",
			"signed-hosted",
		]);
		expect(BUTTON_INTERACTION_PROFILE.blocks.followups.modes).toEqual([
			"native",
			"conversational",
		]);
		expect(BUTTON_INTERACTION_PROFILE.blocks.task.modes).toEqual([
			"native",
			"signed-hosted",
			"conversational",
		]);
		expect(BUTTON_INTERACTION_PROFILE.blocks.form.modes).not.toContain(
			"native",
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks.secret.modes).not.toContain(
			"native",
		);
	});

	it("enables buttons at the conservative 5/25/80/64 boundaries", () => {
		expect(BUTTON_INTERACTION_PROFILE.limits.buttons).toEqual({
			supported: true,
			maxPerRow: 5,
			maxPerMessage: 25,
			maxLabelBytes: 80,
			maxCallbackBytes: 64,
		});
	});

	it("extends fallbacks to native first without dropping the conversational path", () => {
		expect(BUTTON_INTERACTION_PROFILE.nonSecretFallbacks).toEqual([
			"native",
			"conversational",
			"signed-hosted",
		]);
	});

	it("copies overridden containers instead of aliasing the conversational ones", () => {
		expect(BUTTON_INTERACTION_PROFILE).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE,
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.limits,
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks.choice).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks.choice,
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks.followups).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks.followups,
		);
		expect(BUTTON_INTERACTION_PROFILE.blocks.task).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.blocks.task,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.buttons).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.buttons,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.links).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.links,
		);
		expect(BUTTON_INTERACTION_PROFILE.limits.text).not.toBe(
			CONVERSATIONAL_INTERACTION_PROFILE.limits.text,
		);
	});

	it("materializes into a valid profile that keeps the button limits", () => {
		const materialized = profiles.createConnectorInteractionCapabilityProfile({
			template: BUTTON_INTERACTION_PROFILE,
			source: "telegram",
			accountId: "acct-button",
			targetKind: "room",
			targetId: "target-button",
		});
		expect(materialized.profileVersion).toBe(1);
		expect(materialized.limits.buttons).toEqual(
			BUTTON_INTERACTION_PROFILE.limits.buttons,
		);
		expect(materialized.blocks.choice.modes).toContain("native");
		expect(materialized.nonSecretFallbacks).toEqual([
			"native",
			"conversational",
			"signed-hosted",
		]);
	});
});

describe("RICH_INTERACTION_PROFILE", () => {
	it("exposes the high-capability primitive boundaries", () => {
		expect(RICH_INTERACTION_PROFILE.templateId).toBe("rich-native-v1");
		expect(RICH_INTERACTION_PROFILE.limits.buttons).toEqual({
			supported: true,
			maxPerRow: 8,
			maxPerMessage: 100,
			maxLabelBytes: 256,
			maxCallbackBytes: 256,
		});
		expect(RICH_INTERACTION_PROFILE.limits.lists).toEqual({
			supported: true,
			maxItems: 100,
			maxLabelBytes: 256,
			maxDescriptionBytes: 1_024,
		});
		expect(RICH_INTERACTION_PROFILE.limits.modals).toEqual({
			supported: true,
			maxFields: 20,
			maxTitleBytes: 256,
		});
		expect(RICH_INTERACTION_PROFILE.limits.forms).toEqual({
			supported: true,
			maxFields: 20,
			maxOptionsPerField: 100,
		});
		expect(RICH_INTERACTION_PROFILE.limits.links).toEqual({
			supported: true,
			maxUrlBytes: 8_192,
		});
		expect(RICH_INTERACTION_PROFILE.limits.threads).toEqual({
			supported: true,
			maxTitleBytes: 256,
		});
		expect(RICH_INTERACTION_PROFILE.limits.text).toEqual({
			maxMessageBytes: 1_000_000,
		});
		expect(RICH_INTERACTION_PROFILE.limits.attachments).toEqual({
			supported: true,
			maxCount: 20,
			maxBytesEach: 100_000_000,
			mimeTypes: ["*/*"],
		});
	});

	it("allows unbounded edit windows while keeping secrets on the sensitive flow", () => {
		expect(RICH_INTERACTION_PROFILE.limits.edits).toEqual({
			supported: true,
			windowMs: null,
		});
		expect(RICH_INTERACTION_PROFILE.blocks.secret).toEqual({
			modes: ["sensitive-request"],
			maxSessionTtlMs: CONVERSATIONAL_TTL_MS,
		});
	});

	it("adds native to every ordinary block with signed-hosted preferred over conversational", () => {
		expect(RICH_INTERACTION_PROFILE.blocks.choice.modes).toEqual([
			"native",
			"signed-hosted",
			"conversational",
		]);
		expect(RICH_INTERACTION_PROFILE.blocks.form.modes).toEqual([
			"native",
			"signed-hosted",
			"conversational",
		]);
		expect(RICH_INTERACTION_PROFILE.blocks.followups.modes).toEqual([
			"native",
			"conversational",
		]);
		expect(RICH_INTERACTION_PROFILE.blocks.task.modes).toEqual([
			"native",
			"signed-hosted",
			"conversational",
		]);
		expect(RICH_INTERACTION_PROFILE.nonSecretFallbacks).toEqual([
			"native",
			"signed-hosted",
			"conversational",
		]);
	});

	it("does not share overridden containers with the button template", () => {
		expect(RICH_INTERACTION_PROFILE).not.toBe(BUTTON_INTERACTION_PROFILE);
		expect(RICH_INTERACTION_PROFILE.blocks.choice).not.toBe(
			BUTTON_INTERACTION_PROFILE.blocks.choice,
		);
		expect(RICH_INTERACTION_PROFILE.limits.buttons).not.toBe(
			BUTTON_INTERACTION_PROFILE.limits.buttons,
		);
		expect(RICH_INTERACTION_PROFILE.limits).not.toBe(
			BUTTON_INTERACTION_PROFILE.limits,
		);
	});

	it("materializes into a valid profile carrying the rich limits", () => {
		const materialized = profiles.createConnectorInteractionCapabilityProfile({
			template: RICH_INTERACTION_PROFILE,
			source: "matrix",
			accountId: "acct-rich",
			targetKind: "room",
			targetId: "target-rich",
		});
		expect(materialized.profileVersion).toBe(1);
		expect(materialized.limits.attachments).toEqual(
			RICH_INTERACTION_PROFILE.limits.attachments,
		);
		expect(materialized.blocks.form.modes).toContain("native");
		expect(materialized.nonSecretFallbacks).toEqual([
			"native",
			"signed-hosted",
			"conversational",
		]);
	});
});

describe("FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT", () => {
	it("fills every descriptive field on every entry", () => {
		for (const entry of FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT) {
			for (const field of [
				"plugin",
				"registrationSite",
				"source",
				"targetKind",
				"note",
			] as const) {
				expect(entry[field].length, `${entry.source}.${field}`).toBeGreaterThan(
					0,
				);
			}
		}
	});

	it("reserves the button-native family for Discord and Telegram", () => {
		const buttonNative = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.filter(
			(entry) => entry.profileFamily === "button-native",
		).map((entry) => entry.source);
		expect(buttonNative).toEqual(["discord", "telegram"]);
		expect(
			new Set(
				FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.map(
					(entry) => entry.profileFamily,
				),
			),
		).toEqual(new Set(["button-native", "conversational", "read-only"]));
	});

	it("maps every source to its documented target kind", () => {
		expect(
			Object.fromEntries(
				FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.filter(
					(entry) => entry.profileFamily !== "read-only",
				).map((entry) => [entry.source, entry.targetKind]),
			),
		).toEqual({
			discord: "channel",
			gmail: "email",
			"google-chat": "room",
			imessage: "user",
			instagram: "thread",
			matrix: "room",
			slack: "channel",
			telegram: "room",
			wechat: "room",
			whatsapp: "phone",
			x: "user",
		});
	});

	it("attributes both Google surfaces to one registration site", () => {
		const googleEntries = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.filter(
			(entry) => entry.plugin === "plugin-google-workspace",
		);
		expect(googleEntries.map((entry) => entry.source)).toEqual([
			"gmail",
			"google-chat",
		]);
		expect(
			new Set(googleEntries.map((entry) => entry.registrationSite)),
		).toEqual(new Set(["plugin-google-workspace/src/chat/service.ts"]));
	});

	it("materializes every outbound connector into a valid profile", () => {
		for (const entry of FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT) {
			if (entry.profileFamily === "read-only") continue;
			const materialized = profiles.createConnectorInteractionCapabilityProfile(
				{
					template:
						entry.profileFamily === "button-native"
							? BUTTON_INTERACTION_PROFILE
							: CONVERSATIONAL_INTERACTION_PROFILE,
					source: entry.source,
					accountId: `account:${entry.source}`,
					targetKind: entry.targetKind,
					targetId: `target:${entry.source}`,
				},
			);
			expect(materialized.connector.source, entry.source).toBe(entry.source);
			expect(materialized.target.kind, entry.source).toBe(entry.targetKind);
			expect(materialized.sensitiveFallback, entry.source).toBe(
				"sensitive-request",
			);
		}
	});
	it("keeps personal Telegram history targets out of outbound interaction delivery", () => {
		const matrix = renderFirstPartyInteractionCapabilityMatrix();
		const [outbound, readOnly] = matrix.split("## Read-only registrations");
		expect(readOnly).toBeDefined();
		for (const kind of ["user", "channel", "thread"]) {
			expect(readOnly).toContain(
				`| telegram | plugin-telegram/src/account-client-service.ts | ${kind}:<target> | unsupported |`,
			);
			expect(outbound).not.toContain(
				`| telegram | <account> | ${kind}:<target> |`,
			);
		}
		expect(outbound).toContain(
			"| telegram | <account> | room:<target> | choice:native",
		);
	});
});
