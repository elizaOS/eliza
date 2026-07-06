/**
 * Unit tests for the EXPERIENCE mutation action. They use a fake
 * ExperienceService so the assertions stay focused on action routing,
 * confirmation safety, query targeting, and view-field update payloads rather
 * than a live model or database.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "../../../../types/index.ts";
import type { UUID } from "../../../../types/primitives.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";
import { experienceAction } from "./experience.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;
const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;
const EXP_ONE = "00000000-0000-0000-0000-00000000e001" as UUID;
const EXP_TWO = "00000000-0000-0000-0000-00000000e002" as UUID;

function makeExperience(id: UUID, learning: string): Experience {
	return {
		id,
		agentId: AGENT_ID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.NEUTRAL,
		context: "The agent reviewed onboarding guidance.",
		action: "Answered a help request.",
		result: "The response mentioned stale tutorial tiles.",
		learning,
		tags: ["onboarding"],
		domain: "product",
		keywords: ["onboarding", "tutorial"],
		associatedEntityIds: [],
		confidence: 0.7,
		importance: 0.6,
		createdAt: 1_000,
		updatedAt: 1_000,
		accessCount: 0,
	};
}

function makeHarness(initial: Experience[]) {
	const store = new Map(
		initial.map((experience) => [experience.id, experience]),
	);
	const service = {
		getExperience: vi.fn(async (id: UUID) => store.get(id) ?? null),
		queryExperiences: vi.fn(async ({ query }: { query?: string }) =>
			[...store.values()].filter((experience) =>
				`${experience.learning} ${experience.context} ${experience.result}`
					.toLowerCase()
					.includes((query ?? "").toLowerCase()),
			),
		),
		updateExperience: vi.fn(async (id: UUID, updates: Partial<Experience>) => {
			const existing = store.get(id);
			if (!existing) return null;
			const updated = { ...existing, ...updates, updatedAt: 2_000 };
			store.set(id, updated);
			return updated;
		}),
		deleteExperience: vi.fn(async (id: UUID) => store.delete(id)),
	};
	const runtime = {
		agentId: AGENT_ID,
		getService: vi.fn((name: string) =>
			name === "EXPERIENCE" ? service : null,
		),
	} as unknown as IAgentRuntime;
	const message = {
		entityId: USER_ID,
		roomId: ROOM_ID,
		content: { text: "delete that experience", source: "test" },
	} as Memory;
	const run = (parameters: Record<string, unknown>) =>
		experienceAction.handler?.(runtime, message, undefined, {
			parameters,
		} as HandlerOptions);
	return { service, runtime, run };
}

describe("EXPERIENCE action", () => {
	it("requires confirm:true before deleting", async () => {
		const { service, run } = makeHarness([
			makeExperience(EXP_ONE, "Use chat-native tutorial guidance."),
		]);

		const result = await run({ op: "delete", experienceId: EXP_ONE });

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			error: "EXPERIENCE_CONFIRMATION_REQUIRED",
		});
		expect(service.deleteExperience).not.toHaveBeenCalled();
	});

	it("deletes a uniquely resolved experience by query without a raw selector", async () => {
		const { service, run } = makeHarness([
			makeExperience(EXP_ONE, "Use chat-native tutorial guidance."),
		]);

		const result = await run({
			op: "delete",
			query: "chat-native tutorial",
			confirm: true,
		});

		expect(result?.success).toBe(true);
		expect(service.queryExperiences).toHaveBeenCalledWith(
			expect.objectContaining({ query: "chat-native tutorial" }),
		);
		expect(service.deleteExperience).toHaveBeenCalledWith(EXP_ONE);
		expect(result?.data).toMatchObject({
			actionName: "EXPERIENCE",
			op: "delete",
			experienceId: EXP_ONE,
		});
	});

	it("refuses an ambiguous query instead of guessing which experience to delete", async () => {
		const { service, run } = makeHarness([
			makeExperience(EXP_ONE, "Use chat-native tutorial guidance."),
			makeExperience(EXP_TWO, "Prefer chat-native onboarding cards."),
		]);

		const result = await run({
			op: "delete",
			query: "chat-native",
			confirm: true,
		});

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			error: "EXPERIENCE_AMBIGUOUS_QUERY",
		});
		expect(service.deleteExperience).not.toHaveBeenCalled();
		expect(result?.text).toContain(EXP_ONE);
		expect(result?.text).toContain(EXP_TWO);
	});

	it("updates the same editable fields the Character Experience view saves", async () => {
		const { service, run } = makeHarness([
			makeExperience(EXP_ONE, "Use chat-native tutorial guidance."),
		]);

		const result = await run({
			op: "update",
			experienceId: EXP_ONE,
			learning: "Prefer chat-native tutorial cards over launcher tiles.",
			importance: "0.9",
			confidence: 0.85,
			tags: "onboarding, tutorial, chat-native",
			confirm: true,
		});

		expect(result?.success).toBe(true);
		expect(service.updateExperience).toHaveBeenCalledWith(
			EXP_ONE,
			expect.objectContaining({
				learning: "Prefer chat-native tutorial cards over launcher tiles.",
				importance: 0.9,
				confidence: 0.85,
				tags: ["onboarding", "tutorial", "chat-native"],
			}),
		);
		expect(result?.data).toMatchObject({
			actionName: "EXPERIENCE",
			op: "update",
			experienceId: EXP_ONE,
		});
	});
});
