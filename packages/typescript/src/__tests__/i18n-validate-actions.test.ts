import { describe, expect, it, vi } from "vitest";
import { addContactAction } from "../advanced-capabilities/actions/addContact.ts";
import { createTaskAction } from "../advanced-capabilities/actions/createTask.ts";
import { followRoomAction } from "../advanced-capabilities/actions/followRoom.ts";
import { generateImageAction } from "../advanced-capabilities/actions/imageGeneration.ts";
import { muteRoomAction } from "../advanced-capabilities/actions/muteRoom.ts";
import { removeContactAction } from "../advanced-capabilities/actions/removeContact.ts";
import { scheduleFollowUpAction } from "../advanced-capabilities/actions/scheduleFollowUp.ts";
import { searchContactsAction } from "../advanced-capabilities/actions/searchContacts.ts";
import { unmuteRoomAction } from "../advanced-capabilities/actions/unmuteRoom.ts";
import { updateContactAction } from "../advanced-capabilities/actions/updateContact.ts";
import { createPlanAction } from "../advanced-planning/actions/chain-example.ts";
import { scheduleFollowUpAction as planningScheduleFollowUpAction } from "../advanced-planning/actions/scheduleFollowUp.ts";
import { sendToAdminAction } from "../autonomy/action.ts";
import {
	processKnowledgeAction,
	searchKnowledgeAction,
} from "../features/knowledge/actions.ts";
import {
	getValidationKeywordLocaleTerms,
	VALIDATION_KEYWORD_LOCALES,
} from "../i18n/validation-keywords.ts";

const AUDITED_ACTION_KEYWORDS = [
	"action.createTask.request",
	"action.createPlan.request",
	"action.searchContacts.request",
	"action.addContact.request",
	"action.updateContact.request",
	"action.removeContact.request",
	"action.scheduleFollowUp.request",
	"action.followRoom.request",
	"action.muteRoom.request",
	"action.unmuteRoom.request",
	"action.sendToAdmin.request",
	"action.processKnowledge.request",
	"action.searchKnowledge.request",
	"action.generateImage.strong",
	"action.generateImage.weak",
] as const;

function makeMessage(text: string, roomId = "room-1") {
	return {
		entityId: "user-1",
		agentId: "agent-1",
		roomId,
		content: {
			text,
			source: "client_chat",
		},
	} as never;
}

function makeRuntime(options?: {
	autonomyRoomId?: string;
	enableAutonomy?: boolean;
	roomState?: string;
	services?: Record<string, unknown>;
	adminUserId?: string;
}) {
	const services = options?.services ?? {};
	return {
		agentId: "agent-1",
		enableAutonomy: options?.enableAutonomy ?? true,
		getService: vi.fn((name: string) => services[name] ?? null),
		getParticipantUserState: vi
			.fn()
			.mockResolvedValue(options?.roomState ?? "NONE"),
		getSetting: vi.fn((key: string) => {
			if (key === "ADMIN_USER_ID") {
				return options?.adminUserId ?? "admin-1";
			}
			return undefined;
		}),
	} as never;
}

describe("localized validate audit for upstream eliza actions", () => {
	it.each(
		AUDITED_ACTION_KEYWORDS,
	)("has locale terms for every supported language: %s", (key) => {
		for (const locale of VALIDATION_KEYWORD_LOCALES) {
			expect(
				getValidationKeywordLocaleTerms(key, locale).length,
			).toBeGreaterThan(0);
		}
	});

	it("validates create-task requests in Spanish", async () => {
		await expect(
			createTaskAction.validate?.(
				makeRuntime(),
				makeMessage("programa un recordatorio cada semana"),
			),
		).resolves.toBe(true);
	});

	it("validates create-plan requests in Chinese", async () => {
		await expect(
			createPlanAction.validate?.(
				makeRuntime(),
				makeMessage("帮我制定一个项目计划"),
			),
		).resolves.toBe(true);
	});

	it("validates search-contacts requests in Chinese", async () => {
		await expect(
			searchContactsAction.validate?.(
				makeRuntime({ services: { relationships: {} } }),
				makeMessage("搜索联系人"),
			),
		).resolves.toBe(true);
	});

	it("validates add-contact requests in Korean", async () => {
		await expect(
			addContactAction.validate?.(
				makeRuntime({ services: { relationships: {} } }),
				makeMessage("연락처 추가"),
			),
		).resolves.toBe(true);
	});

	it("validates update-contact requests in Portuguese", async () => {
		await expect(
			updateContactAction.validate?.(
				makeRuntime({ services: { relationships: {} } }),
				makeMessage("atualiza contato"),
			),
		).resolves.toBe(true);
	});

	it("validates remove-contact requests in Spanish", async () => {
		await expect(
			removeContactAction.validate?.(
				makeRuntime({ services: { relationships: {} } }),
				makeMessage("elimina contacto"),
			),
		).resolves.toBe(true);
	});

	it("validates advanced-capabilities follow-up requests in Vietnamese", async () => {
		await expect(
			scheduleFollowUpAction.validate?.(
				makeRuntime({
					services: {
						relationships: {},
						follow_up: {},
					},
				}),
				makeMessage("nhắc tôi liên hệ lại với Lan vào tuần sau"),
			),
		).resolves.toBe(true);
	});

	it("validates advanced-planning follow-up requests in Tagalog", async () => {
		await expect(
			planningScheduleFollowUpAction.validate?.(
				makeRuntime({
					services: {
						relationships: {},
						follow_up: {},
					},
				}),
				makeMessage("iskedyul ang follow up kay Maya bukas"),
			),
		).resolves.toBe(true);
	});

	it("validates follow-room requests in Spanish", async () => {
		await expect(
			followRoomAction.validate?.(
				makeRuntime({ roomState: "NONE" }),
				makeMessage("sigue esta sala"),
			),
		).resolves.toBe(true);
	});

	it("validates mute-room requests in Korean", async () => {
		await expect(
			muteRoomAction.validate?.(
				makeRuntime({ roomState: "FOLLOWED" }),
				makeMessage("조용히 해"),
			),
		).resolves.toBe(true);
	});

	it("validates unmute-room requests in Chinese", async () => {
		await expect(
			unmuteRoomAction.validate?.(
				makeRuntime({ roomState: "MUTED" }),
				makeMessage("取消静音"),
			),
		).resolves.toBe(true);
	});

	it("validates send-to-admin requests in Spanish", async () => {
		await expect(
			sendToAdminAction.validate?.(
				makeRuntime({
					services: {
						AUTONOMY: {
							getAutonomousRoomId: () => "autonomy-room",
						},
					},
					adminUserId: "admin-1",
				}),
				makeMessage(
					"avisa al administrador sobre el progreso",
					"autonomy-room",
				),
			),
		).resolves.toBe(true);
	});

	it("validates process-knowledge requests in Spanish", async () => {
		await expect(
			processKnowledgeAction.validate?.(
				makeRuntime({ services: { knowledge: {} } }),
				makeMessage("agrega al conocimiento este documento"),
			),
		).resolves.toBe(true);
	});

	it("validates search-knowledge requests in Portuguese", async () => {
		await expect(
			searchKnowledgeAction.validate?.(
				makeRuntime({ services: { knowledge: {} } }),
				makeMessage("busca conhecimento sobre redes neurais"),
			),
		).resolves.toBe(true);
	});

	it("validates generate-image requests in Korean", async () => {
		await expect(
			generateImageAction.validate?.(
				makeRuntime(),
				makeMessage("고양이 일러스트 이미지 생성"),
			),
		).resolves.toBe(true);
	});
});
