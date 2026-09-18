/** Exercises real provider composition and rendered model inputs: dialogue and
 * character preferences reach Stage 1, domain providers wait for planning, and
 * cached planning context cannot leak back into a later response decision.
 * Uses an in-memory runtime and counting providers; no model or network. */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { userPersonalityProvider } from "../features/advanced-capabilities/personality/providers/user-personality";
import { PersonalityStore } from "../features/advanced-capabilities/personality/services/personality-store";
import { botAwarenessProvider } from "../features/basic-capabilities/providers/botAwareness";
import { choiceProvider } from "../features/basic-capabilities/providers/choice";
import { AgentRuntime } from "../runtime";
import { renderContextObject } from "../runtime/context-renderer";
import { stage1ResponseStateProviderNames } from "../services/message";
import { createV5MessageContextObject } from "../services/message/context-assembly";
import {
	composeResponseState,
	selectV5PlannerStateProviderNames,
} from "../services/message/provider-state";
import { renderMessageHandlerModelInput } from "../services/message/stage1-input";
import type { Character, Content, Memory, Provider, UUID } from "../types";
import { ChannelType } from "../types";

const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMessage(
	id: string,
	text = "gm",
	content: Partial<Content> = {},
): Memory {
	return {
		id: id as UUID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text, ...content },
	};
}

/** Provider whose text changes on every run, so reuse vs re-run is observable. */
function countingProvider(name: string): {
	provider: Provider;
	calls: () => number;
} {
	let n = 0;
	return {
		provider: {
			name,
			get: async () => {
				n += 1;
				return { text: `${name}#${n}`, values: {}, data: {} };
			},
		},
		calls: () => n,
	};
}

describe("stage1ResponseStateProviderNames", () => {
	it("composes the actual user's saved style before context selection without exposing another user's slot", async () => {
		const runtime = new AgentRuntime({
			character: { name: "preference-stage1" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
		});
		const store = (await PersonalityStore.start(runtime)) as PersonalityStore;
		runtime.services.set(PersonalityStore.serviceType, [store]);
		await store.addDirective({
			userId: ENTITY_ID,
			agentId: runtime.agentId,
			actorId: ENTITY_ID,
			directive: "Write headings in sentence case.",
			source: "user",
		});
		runtime.registerProvider(userPersonalityProvider);
		const message = makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1", "hi");
		const names = stage1ResponseStateProviderNames(runtime, message, ["USER"]);
		const state = await runtime.composeState(message, names, true);
		expect(state.text).toContain("Write headings in sentence case.");
		const other = {
			...message,
			id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2" as UUID,
			entityId: "22222222-2222-2222-2222-222222222223" as UUID,
		};
		const otherState = await runtime.composeState(
			other,
			stage1ResponseStateProviderNames(runtime, other, ["USER"]),
			true,
		);
		expect(otherState.text).not.toContain("Write headings in sentence case.");
		expect(
			stage1ResponseStateProviderNames(runtime, message, ["GUEST"]),
		).not.toContain(userPersonalityProvider.name);
	});

	it.each([ChannelType.DM, ChannelType.GROUP, ChannelType.VOICE_DM])(
		"defers domain providers until planning on %s and preserves complete dialogue",
		async (channelType) => {
			const runtime = new AgentRuntime({
				character: { name: "context-test", system: "Be precise." } as Character,
			});
			const dialogue =
				"first retained turn\n" +
				"complete dialogue ".repeat(5000) +
				"\nlast retained turn";
			const recent = countingProvider("RECENT_MESSAGES");
			recent.provider.get = async () => ({ text: dialogue });
			const interpretation = [
				"recent-conversations",
				"relevant-conversations",
				"BOT_AWARENESS",
				"CHOICE",
			].map(countingProvider);
			const domains = [
				"FACTS",
				"CURRENT_TIME",
				"ATTACHMENTS",
				"RECENT_ERRORS",
				"DOCUMENTS",
				"uiWidgetCapabilities",
				"uiWidgets",
				"uiGenerative",
			].map(countingProvider);
			for (const item of domains) item.provider.alwaysInResponseState = true;
			for (const item of [recent, ...interpretation, ...domains])
				runtime.registerProvider(item.provider);
			runtime.registerPipelineHook({
				id: "attempt-stage-expansion",
				phase: "compose_state_providers",
				handler: (_runtime, context) => {
					if (context.phase === "compose_state_providers")
						context.providers.current.push("DOCUMENTS");
				},
			});
			const message = makeMessage(
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3",
				"hello",
				{
					channelType,
					mentionContext: { isMention: true, isReply: false, isThread: false },
				},
			);
			const state = await composeResponseState(runtime, message);
			const context = await createV5MessageContextObject({
				runtime,
				message,
				state,
				userRoles: ["OWNER"],
			});
			const wire = JSON.stringify(
				renderMessageHandlerModelInput(runtime, context).messages,
			);
			expect(wire).toContain(JSON.stringify(dialogue).slice(1, -1));
			expect(wire).toContain("hello");
			for (const item of interpretation) {
				expect(item.calls()).toBe(1);
				expect(wire).toContain(`${item.provider.name}#1`);
			}
			for (const item of domains) {
				expect(item.calls()).toBe(0);
				expect(wire).not.toContain(`${item.provider.name}#`);
			}
			const plannerState = await runtime.composeState(
				message,
				selectV5PlannerStateProviderNames({
					runtime,
					message,
					selectedContexts: ["general"],
					userRoles: ["OWNER"],
				}),
				true,
				false,
				[],
			);
			const plannerContext = await createV5MessageContextObject({
				runtime,
				message,
				state: plannerState,
				includeTools: true,
				userRoles: ["OWNER"],
			});
			const plannerWire = JSON.stringify(renderContextObject(plannerContext));
			for (const item of domains) {
				expect(item.calls()).toBe(1);
				expect(plannerWire).toContain(`${item.provider.name}#1`);
			}
			expect(plannerWire).toContain(JSON.stringify(dialogue).slice(1, -1));
			const completion = await createV5MessageContextObject({
				runtime,
				message,
				state: plannerState,
				includeTools: false,
				providerPhase: "completion",
				userRoles: ["OWNER"],
			});
			const completionWire = JSON.stringify(renderContextObject(completion));
			for (const item of domains)
				expect(completionWire).toContain(`${item.provider.name}#1`);

			// The same turn can already have a full cached planning state. Its
			// next Stage-1 render must still honor the stage boundary.
			const restored = await createV5MessageContextObject({
				runtime,
				message,
				state: plannerState,
				userRoles: ["OWNER"],
			});
			const restoredWire = JSON.stringify(
				renderMessageHandlerModelInput(runtime, restored).messages,
			);
			for (const item of domains)
				expect(restoredWire).not.toContain(`${item.provider.name}#`);
			expect(restoredWire).toContain(JSON.stringify(dialogue).slice(1, -1));
		},
	);

	it("renders stored pending choices and incoming selected values before a reply decision", async () => {
		const runtime = new AgentRuntime({
			character: { name: "choices" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
		});
		runtime.registerProvider(choiceProvider);
		await runtime.createTask({
			name: "Choose delivery",
			agentId: runtime.agentId,
			roomId: ROOM_ID,
			tags: ["AWAITING_CHOICE"],
			metadata: {
				options: [
					{ name: "pickup", description: "Collect at the desk" },
					{ name: "courier", description: "Deliver tomorrow" },
				],
			},
		});
		const message = makeMessage(
			"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb5",
			"second one",
			{
				metadata: {
					selectedValue: "courier",
					parentMessageId: "original-control",
				},
			},
		);
		const state = await runtime.composeState(
			message,
			stage1ResponseStateProviderNames(runtime, message, ["USER"]),
			true,
		);
		const context = await createV5MessageContextObject({
			runtime,
			message,
			state,
			userRoles: ["USER"],
		});
		const wire = JSON.stringify(
			renderMessageHandlerModelInput(runtime, context).messages,
		);
		expect(wire).toContain("Deliver tomorrow");
		expect(wire).toContain("courier");
		expect(wire).toContain("original-control");
	});

	it.each(["USER", "OWNER"] as const)(
		"advertises standalone memory search only when its %s gate permits the caller",
		async (minRole) => {
			const runtime = new AgentRuntime({
				character: { name: "recall" } as Character,
			});
			runtime.registerAction({
				name: "MEMORY_SEARCH",
				description: "Search stored messages",
				contexts: ["memory"],
				roleGate: { minRole },
				parameters: [],
				validate: async () => true,
				handler: async () => ({ success: true }),
			});
			const context = await createV5MessageContextObject({
				runtime,
				message: makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb6"),
				state: { text: "", values: {}, data: {} },
				userRoles: ["USER"],
				availableContexts: [
					{ id: "memory", label: "Memory", description: "Stored messages" },
				],
			});
			const wire = JSON.stringify(
				renderMessageHandlerModelInput(runtime, context).messages,
			);
			expect(
				wire.includes("No separate chat-history search is available this turn"),
			).toBe(minRole === "OWNER");
		},
	);

	it("renders bot-loop evidence before deciding on a group reply, but stays inert for humans", async () => {
		const runtime = new AgentRuntime({
			character: { name: "bot-awareness" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
		});
		runtime.registerProvider(botAwarenessProvider);
		await runtime.createMemory(
			{
				...makeMessage("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb7", "Thanks"),
				agentId: runtime.agentId,
				entityId: runtime.agentId,
				createdAt: 1,
			},
			"messages",
		);
		const message = {
			...makeMessage(
				"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb8",
				"You are welcome",
				{ channelType: ChannelType.GROUP, metadata: { fromBot: true } },
			),
			createdAt: 2,
		};
		const state = await runtime.composeState(
			message,
			stage1ResponseStateProviderNames(runtime, message, ["GUEST"]),
			true,
		);
		const context = await createV5MessageContextObject({
			runtime,
			message,
			state,
			userRoles: ["GUEST"],
		});
		expect(
			JSON.stringify(renderMessageHandlerModelInput(runtime, context).messages),
		).toContain("Talking to another bot");
		const human = {
			...message,
			content: { ...message.content, metadata: { fromBot: false } },
		};
		const humanState = await runtime.composeState(
			human,
			stage1ResponseStateProviderNames(runtime, human, ["GUEST"]),
			true,
			true,
		);
		expect(humanState.text).not.toContain("Talking to another bot");
	});

	it("does not render unattributed cached planning state as response context", async () => {
		const runtime = new AgentRuntime({
			character: { name: "context-test" } as Character,
		});
		const message = makeMessage(
			"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4",
			"hello",
		);
		const state = {
			text: "unattributed private planner payload",
			values: {},
			data: {},
		};
		const context = await createV5MessageContextObject({
			runtime,
			message,
			state,
		});
		const wire = JSON.stringify(
			renderMessageHandlerModelInput(runtime, context).messages,
		);
		expect(wire).not.toContain(state.text);
		expect(wire).toContain("hello");
	});
});
