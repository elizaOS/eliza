import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Memory, UUID } from "../../../types/index.ts";
import type { SetupConfig, SetupSetting } from "./config.ts";
import { SetupService } from "./service.ts";

function setting(name: string, over: Partial<SetupSetting> = {}): SetupSetting {
	return {
		name,
		description: `${name} description`,
		secret: true,
		public: false,
		required: true,
		dependsOn: [],
		value: null,
		...over,
	};
}

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;

function seedSession(svc: SetupService, config: SetupConfig): void {
	// The session map is private; inject a minimal session directly (a null
	// secretsService is fine — processMessage still updates local state and
	// reaches the settingUpdated branch under test).
	(svc as unknown as { sessions: Map<UUID, unknown> }).sessions.set(ROOM, {
		worldId: "22222222-2222-2222-2222-222222222222" as UUID,
		userId: "33333333-3333-3333-3333-333333333333" as UUID,
		roomId: ROOM,
		config,
		currentSettingKey: "openai",
		startedAt: 0,
		lastActivityAt: 0,
		platform: "other",
		mode: "conversational",
	});
}

describe("SetupService.processMessage — settingUpdated message", () => {
	it("substitutes {{settingName}} in a CUSTOM settingUpdated message", async () => {
		const svc = new SetupService(createMockRuntime());
		const config: SetupConfig = {
			settings: {
				openai: setting("OpenAI Key"),
				anthropic: setting("Anthropic Key"),
			},
			// Custom message with the documented template variable.
			messages: { settingUpdated: "Saved your {{settingName}} securely." },
		};
		seedSession(svc, config);

		const result = await svc.processMessage(ROOM, {
			content: { text: "sk-test-value" },
		} as Memory);

		// Before the fix, `.replace` bound only to the DEFAULT, so a custom
		// message shipped the raw placeholder.
		expect(result.response).toContain("Saved your OpenAI Key securely.");
		expect(result.response).not.toContain("{{settingName}}");
	});

	it("reports the just-answered key as updatedKey, not the next one", async () => {
		const svc = new SetupService(createMockRuntime());
		const config: SetupConfig = {
			settings: {
				openai: setting("OpenAI Key"),
				anthropic: setting("Anthropic Key"),
			},
		};
		seedSession(svc, config);

		const result = await svc.processMessage(ROOM, {
			content: { text: "sk-test-value" },
		} as Memory);

		// currentSettingKey was reassigned to the next key before the return;
		// the reported key must still be the one just answered.
		expect(result.updatedKey).toBe("openai");
	});
});
