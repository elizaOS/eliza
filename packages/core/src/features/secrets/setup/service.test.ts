/**
 * Deterministic unit test for SetupService (features/secrets/setup): the
 * {{settingName}} substitution and updatedKey reporting in processMessage's
 * settingUpdated path, plus startTelegramSetup dispatching the owner deep link
 * through the runtime send registry (and staying silent without ownership
 * metadata). Uses createMockRuntime with a seeded in-memory session — no live
 * Telegram.
 */
import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { Memory, TargetInfo, UUID } from "../../../types/index.ts";
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

		// The substitution must bind to the resolved (custom or default) message;
		// a custom message must not ship the raw placeholder.
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

describe("SetupService.startTelegramSetup", () => {
	const world = { id: "44444444-4444-4444-4444-444444444444" as UUID };
	const ownerEntities = [
		{
			metadata: {
				telegram: {
					id: "owner-telegram-id",
					username: "owner_username",
					adminTitle: "Owner",
				},
			},
		},
	];

	it("sends the owner deep link through the runtime send registry", async () => {
		const sendMessageToTarget = vi.fn(async () => undefined);
		const getService = vi.fn();
		const svc = new SetupService(
			createMockRuntime({
				sendMessageToTarget,
				getService,
			}),
		);

		await svc.startTelegramSetup(
			world as never,
			{ id: -100123456 },
			ownerEntities,
			"my_agent_bot",
		);

		expect(sendMessageToTarget).toHaveBeenCalledWith(
			{
				source: "telegram",
				channelId: "-100123456",
			} satisfies TargetInfo,
			{
				text: "Hello @owner_username! Could we take a few minutes to get everything set up? Please click this link to start chatting with me: https://t.me/my_agent_bot?start=setup",
				source: "telegram",
			},
		);
		expect(getService).not.toHaveBeenCalled();
	});

	it("does not send when Telegram ownership metadata is missing", async () => {
		const sendMessageToTarget = vi.fn(async () => undefined);
		const svc = new SetupService(
			createMockRuntime({
				sendMessageToTarget,
			}),
		);

		await svc.startTelegramSetup(
			world as never,
			{ id: -100123456 },
			[
				{
					metadata: {
						telegram: {
							id: "admin-telegram-id",
							username: "admin_username",
							adminTitle: "Administrator",
						},
					},
				},
			],
			"my_agent_bot",
		);

		expect(sendMessageToTarget).not.toHaveBeenCalled();
	});
});
