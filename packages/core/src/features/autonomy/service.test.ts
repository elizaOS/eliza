import { describe, expect, test } from "vitest";
import type { IAgentRuntime } from "../../types";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptArtifact,
	OptimizedPromptService,
} from "../../services/optimized-prompt";
import { AutonomyService } from "./service";

function makeOptimizedAutonomyService(prompt: string): OptimizedPromptService {
	const service = new OptimizedPromptService();
	service.setDisabledTasksFromEnv(undefined);
	const direct = service as unknown as {
		cache: {
			autonomy?: { artifact: OptimizedPromptArtifact; loadedAt: number };
		};
	};
	direct.cache.autonomy = {
		artifact: {
			task: "autonomy",
			optimizer: "gepa",
			baseline: "BASELINE {{targetRoomContext}} {{lastThought}}",
			prompt,
			score: 0.9,
			baselineScore: 0.5,
			datasetId: "autonomy-test",
			datasetSize: 4,
			generatedAt: "2026-05-20T00:00:00.000Z",
			lineage: [{ round: 1, variant: 0, score: 0.9 }],
		},
		loadedAt: Date.now(),
	};
	return service;
}

describe("AutonomyService optimized prompt integration", () => {
	test("fills the GEPA-optimized autonomy prompt when an autonomy artifact is loaded", () => {
		const optimizedPromptService = makeOptimizedAutonomyService(
			"GEPA autonomy prompt\ncontext={{targetRoomContext}}\nlast={{lastThought}}",
		);
		const service = new AutonomyService();
		(service as unknown as { runtime: IAgentRuntime }).runtime = {
			getService<T>(name: string): T | null {
				if (name === OPTIMIZED_PROMPT_SERVICE) {
					return optimizedPromptService as T;
				}
				return null;
			},
		} as unknown as IAgentRuntime;

		const output = (
			service as unknown as {
				fillAutonomyTemplate: (
					template: string,
					values: { targetRoomContext: string; lastThought: string },
				) => string;
			}
		).fillAutonomyTemplate("baseline {{targetRoomContext}} {{lastThought}}", {
			targetRoomContext: "room context",
			lastThought: "prior note",
		});

		expect(output).toBe(
			"GEPA autonomy prompt\ncontext=room context\nlast=prior note",
		);
	});
});
