import {
	formatEvaluatorExampleDescriptions,
	formatEvaluatorExamples,
	formatEvaluatorNames,
	formatEvaluators,
} from "../src/evaluators";
import type {
	Evaluator,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../src/types";

// Mock data for evaluators
/**
 * Array of mock evaluators.
 * @type {Evaluator[]}
 */
const mockEvaluators: Evaluator[] = [
	{
		name: "Evaluator1",
		description: "This is the first evaluator.",
		examples: [
			{
				context: "Context 1 with {{user1}}.",
				outcome: "Outcome 1 with {{user1}}.",
				messages: [
					{
						user: "user1",
						content: { text: "Message 1", action: "action1" },
					},
					{ user: "user2", content: { text: "Message 2" } },
				],
			},
		],
		similes: [],
		handler: (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state?: State,
			_options?: { [key: string]: unknown },
			_callback?: HandlerCallback,
		): Promise<unknown> => {
			throw new Error("Function not implemented.");
		},
		validate: (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state?: State,
		): Promise<boolean> => {
			throw new Error("Function not implemented.");
		},
	},
	{
		name: "Evaluator2",
		description: "This is the second evaluator.",
		examples: [
			{
				context: "Context 2 with {{user1}} and {{user2}}.",
				outcome: "Outcome 2 with {{user1}} and {{user2}}.",
				messages: [
					{
						user: "user1",
						content: { text: "Message 1", action: "action1" },
					},
					{ user: "user2", content: { text: "Message 2" } },
				],
			},
		],
		similes: [],
		handler: (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state?: State,
			_options?: { [key: string]: unknown },
			_callback?: HandlerCallback,
		): Promise<unknown> => {
			throw new Error("Function not implemented.");
		},
		validate: (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state?: State,
		): Promise<boolean> => {
			throw new Error("Function not implemented.");
		},
	},
];

// Unit test for formatEvaluatorNames
test("formats evaluator names correctly", () => {
	const result = formatEvaluatorNames(mockEvaluators);
	expect(result).toBe("'Evaluator1',\n'Evaluator2'");
});

// Unit test for formatEvaluators
test("formats evaluators correctly", () => {
	const result = formatEvaluators(mockEvaluators);
	expect(result).toBe(
		"'Evaluator1: This is the first evaluator.',\n'Evaluator2: This is the second evaluator.'",
	);
});

// Unit test for formatEvaluatorExamples
test("formats evaluator examples correctly", () => {
	const result = formatEvaluatorExamples(mockEvaluators);
	expect(result).toContain("Context:\nContext 1 with");
	expect(result).toContain("Outcome:\nOutcome 1 with");
	expect(result).toContain("Messages:\nuser1: Message 1 (action1)");
});

// Unit test for formatEvaluatorExampleDescriptions
test("formats evaluator example descriptions correctly", () => {
	const result = formatEvaluatorExampleDescriptions(mockEvaluators);
	expect(result).toBe(
		"Evaluator1 Example 1: This is the first evaluator.\n\nEvaluator2 Example 1: This is the second evaluator.",
	);
});

// Additional tests can be added to ensure edge cases and larger inputs are handled
