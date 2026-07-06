/**
 * Regression coverage for benchmark-shaped chatter phrases that used to hide
 * the provider/action catalog before model judgment could see an actual request.
 * The remaining helper is only the relationship follow-up narrowing path.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type Action,
	FOLLOW_UP_CAPABLE_ACTION_TAG,
	type Handler,
	type Provider,
} from "../../../types/components";
import type { Memory } from "../../../types/memory";
import type { UUID } from "../../../types/primitives";
import type { IAgentRuntime } from "../../../types/runtime";
import type { State } from "../../../types/state";
import { actionsProvider } from "./actions";
import { looksLikeRelationshipFollowUpReminder } from "./non-actionable-chatter";
import { providersProvider } from "./providers";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000000c1" as UUID;

const state = { values: {}, data: {}, text: "" } as State;

function message(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000d1" as UUID,
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text },
		createdAt: 1,
	};
}

function action(name: string, tags: string[] = []): Action {
	return {
		name,
		description: `${name} action`,
		tags,
		validate: vi.fn(async () => true),
		handler: vi.fn(async () => undefined) as Handler,
	};
}

function provider(name: string): Provider {
	return {
		name,
		description: `${name} provider`,
		contexts: ["general"],
		get: vi.fn(async () => ({ text: "" })),
	};
}

function runtime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		actions: [],
		providers: [],
		...overrides,
	} as IAgentRuntime;
}

describe("catalog visibility for benchmark-shaped chatter phrases", () => {
	it("keeps concrete actions visible when a benchmark-negative phrase also asks for work", async () => {
		const archiveNewsletters = action("ARCHIVE_NEWSLETTERS");
		const reply = action("REPLY");
		const result = await actionsProvider.get(
			runtime({ actions: [archiveNewsletters, reply] }),
			message("I hate email - archive all my newsletters"),
			state,
		);

		const names = (result.data?.actionsData as Action[]).map(
			(item) => item.name,
		);
		expect(names).toContain("ARCHIVE_NEWSLETTERS");
		expect(names).toContain("REPLY");
	});

	it("keeps provider catalog entries visible for the same false-positive phrase", async () => {
		const result = await providersProvider.get(
			runtime({ providers: [provider("INBOX")] }),
			message("I hate email - summarize my inbox"),
			state,
		);

		const names = (result.data?.allProviders as Array<{ name: string }>).map(
			(item) => item.name,
		);
		expect(names).toContain("INBOX");
	});

	it("still recognizes one-off relationship follow-up reminders", () => {
		expect(
			looksLikeRelationshipFollowUpReminder(
				message("follow up with Maya tomorrow"),
			),
		).toBe(true);
		expect(
			looksLikeRelationshipFollowUpReminder(
				message("follow up with Maya every Friday"),
			),
		).toBe(false);
	});

	it("narrows relationship follow-up reminders to follow-up-capable actions when one is available", async () => {
		const followUp = action("CONTACT_FOLLOW_UP", [
			FOLLOW_UP_CAPABLE_ACTION_TAG,
		]);
		const calendar = action("CALENDAR_CREATE");
		const reply = action("REPLY");
		const result = await actionsProvider.get(
			runtime({ actions: [followUp, calendar, reply] }),
			message("follow up with Maya tomorrow"),
			state,
		);

		const names = (result.data?.actionsData as Action[]).map(
			(item) => item.name,
		);
		expect(names).toContain("CONTACT_FOLLOW_UP");
		expect(names).toContain("REPLY");
		expect(names).not.toContain("CALENDAR_CREATE");
	});
});
