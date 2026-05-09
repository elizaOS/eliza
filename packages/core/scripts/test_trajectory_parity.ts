import { v4 } from "uuid";
import { type IAgentRuntime, type Memory, ModelType, type State } from "../src";
import { TrajectoriesService } from "../src/services/trajectories";

// Mock runtime setup
async function runTest() {
	console.log("Starting Trajectory Parity Test...");

	let trajectoriesService: TrajectoriesService | undefined;
	const mockRuntime = {
		agentId: v4(),
		providers: [],
		getService: (name: string) => {
			if (name === "trajectories") return trajectoriesService ?? null;
			return null;
		},
		composeState: async (
			_msg: Memory,
			_includeList?: string[],
			_onlyInclude?: boolean,
			_skipCache?: boolean,
			phase?: string,
		): Promise<State> => {
			trajectoriesService?.logProviderAccess({
				stepId: "test-step-id",
				providerName: "test-provider",
				data: { textLength: 10 },
				purpose: phase ? `compose_state:${phase}` : "compose_state",
			});
			return { values: {}, data: {}, text: "" };
		},
		useModel: async (
			model: ModelType,
			_params: { prompt?: string },
		): Promise<string> => {
			trajectoriesService?.logLlmCall({
				stepId: "test-step-id",
				model: String(model),
				systemPrompt: "",
				userPrompt: "",
				response: String(model).includes("EMBEDDING")
					? "[embedding vector]"
					: "response",
				temperature: 0,
				maxTokens: 0,
				purpose: "action",
				actionType: "runtime.useModel",
				latencyMs: 10,
			});
			return "response";
		},
	};

	const runtime = mockRuntime as IAgentRuntime;
	trajectoriesService = new TrajectoriesService(runtime);

	// Test 1: Phase Labels
	console.log("Test 1: Phase Labels");
	await mockRuntime.composeState({} as Memory, [], false, false, "generate");
	const accessLogs = trajectoriesService.getProviderAccessLogs();
	const generateLog = accessLogs.find(
		(l) => l.purpose === "compose_state:generate",
	);

	if (generateLog) {
		console.log("✅ Phase label 'compose_state:generate' found");
	} else {
		console.error("❌ Phase label 'compose_state:generate' NOT found");
		console.log("Logs:", accessLogs);
	}

	// Test 2: Embedding Truncation
	console.log("Test 2: Embedding Truncation");
	await runtime.useModel(ModelType.TEXT_EMBEDDING, { prompt: "test" });
	const llmLogs = trajectoriesService.getLlmCallLogs();
	const embeddingLog = llmLogs.find(
		(l) => l.model.includes("EMBEDDING") && l.response === "[embedding vector]",
	);

	if (embeddingLog) {
		console.log("✅ Embedding response truncated");
	} else {
		console.error("❌ Embedding response NOT truncated");
		console.log("Logs:", llmLogs);
	}

	// Test 3: Step Completion
	console.log("Test 3: Step Completion");
	if (typeof trajectoriesService.completeStepByStepId === "function") {
		console.log("✅ completeStepByStepId method exists");
	} else {
		console.error("❌ completeStepByStepId method MISSING");
	}
}

runTest().catch(console.error);
