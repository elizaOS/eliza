import {
	composeContext,
	generateText,
	getGoals,
	parseJsonArrayFromText,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goalEvaluator } from "../../src/evaluators/goal";

vi.mock("@elizaos/core", () => ({
	composeContext: vi.fn(),
	generateText: vi.fn(),
	getGoals: vi.fn(),
	parseJsonArrayFromText: vi.fn(),
	ModelClass: {
		SMALL: "small",
	},
}));

describe("goalEvaluator", () => {
	let mockRuntime;
	let mockMessage;

	beforeEach(() => {
		mockRuntime = {
			character: {
				settings: {},
			},
			messageManager: {
				countMemories: vi.fn().mockResolvedValue(5),
			},
			composeState: vi.fn().mockResolvedValue({
				agentId: "test-agent",
				roomId: "test-room",
				goals: [{ id: "test-goal", name: "Test Goal" }],
			}),
			getConversationLength: vi.fn().mockReturnValue(10),
			databaseAdapter: {
				updateGoal: vi.fn().mockResolvedValue(true),
			},
		};

		mockMessage = {
			content: {
				text: "I have completed the project documentation.",
			},
			roomId: "test-room",
		};

		// Reset all mocks
		vi.clearAllMocks();
	});

	describe("validation", () => {
		it("should validate successfully", async () => {
			// Mock the getGoals function to return an active goal
			vi.mocked(getGoals).mockImplementation(
				async ({ runtime, roomId, onlyInProgress }) => {
					expect(runtime).toBe(mockRuntime);
					expect(roomId).toBe("test-room");
					expect(onlyInProgress).toBe(true);
					return [
						{ id: "test-goal", name: "Test Goal", status: "IN_PROGRESS" },
					];
				},
			);

			const result = await goalEvaluator.validate(mockRuntime, mockMessage);
			expect(result).toBe(true);
			expect(getGoals).toHaveBeenCalledWith({
				runtime: mockRuntime,
				count: 1,
				onlyInProgress: true,
				roomId: "test-room",
			});
		});
	});

	describe("evaluator properties", () => {
		it("should have correct evaluator properties", () => {
			expect(goalEvaluator.name).toBe("UPDATE_GOAL");
			expect(goalEvaluator.similes).toContain("UPDATE_GOALS");
			expect(goalEvaluator.description).toBeDefined();
			expect(goalEvaluator.description).toContain("Analyze the conversation");
			expect(goalEvaluator.examples).toBeDefined();
			expect(Array.isArray(goalEvaluator.examples)).toBe(true);
		});

		it("should have valid examples", () => {
			goalEvaluator.examples.forEach((example) => {
				expect(example).toBeDefined();
				// will add more specific example validations based on the example structure
			});
		});
	});

	describe("goal updates", () => {
		it("should handle goal updates", async () => {
			const mockGoals = [
				{
					id: "goal-1",
					name: "Complete Project Documentation",
					status: "IN_PROGRESS",
					objectives: [
						{
							description: "Write project overview",
							completed: true,
						},
						{
							description: "Document API endpoints",
							completed: false,
						},
					],
				},
			];

			const mockUpdatedGoals = [
				{
					id: "goal-1",
					status: "DONE",
					objectives: [
						{
							description: "Write project overview",
							completed: true,
						},
						{
							description: "Document API endpoints",
							completed: true,
						},
					],
				},
			];

			vi.mocked(composeContext).mockReturnValue("mock-context");
			vi.mocked(getGoals).mockResolvedValue(mockGoals);
			vi.mocked(generateText).mockResolvedValue(
				JSON.stringify(mockUpdatedGoals),
			);
			vi.mocked(parseJsonArrayFromText).mockReturnValue(mockUpdatedGoals);

			const result = await goalEvaluator.handler(mockRuntime, mockMessage);

			expect(composeContext).toHaveBeenCalled();
			expect(getGoals).toHaveBeenCalled();
			expect(generateText).toHaveBeenCalled();
			expect(parseJsonArrayFromText).toHaveBeenCalled();
			expect(mockRuntime.getDatabaseAdapter().updateGoal).toHaveBeenCalled();
			expect(result).toBeDefined();
		});
	});
});
