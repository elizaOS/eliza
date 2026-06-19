import { describe, expect, it } from "vitest";
import type { InstalledModel } from "@elizaos/shared";
import { buildRecommendedAssignments } from "../src/services/assignments.ts";

function makeModel(overrides: Partial<InstalledModel> & { id: string }): InstalledModel {
	return {
		id: overrides.id,
		displayName: overrides.displayName ?? overrides.id,
		path: overrides.path ?? `/tmp/${overrides.id}.gguf`,
		sizeBytes: overrides.sizeBytes ?? 1_000_000,
		installedAt: overrides.installedAt ?? "2026-05-14T00:00:00Z",
		lastUsedAt: overrides.lastUsedAt ?? null,
		source: overrides.source ?? "eliza-download",
		bundleVerifiedAt: overrides.bundleVerifiedAt,
	};
}

describe("buildRecommendedAssignments", () => {
	it("prefers a verified eliza-1 download when available", () => {
		const installed: InstalledModel[] = [
			makeModel({
				id: "eliza-1-2b",
				sizeBytes: 2_000_000_000,
				bundleVerifiedAt: "2026-05-14T00:00:00Z",
			}),
			makeModel({
				id: "llama-3.2-3b-instruct",
				source: "external-scan",
				sizeBytes: 3_000_000_000,
			}),
		];
		expect(buildRecommendedAssignments(installed)).toEqual({
			TEXT_SMALL: "eliza-1-2b",
			TEXT_LARGE: "eliza-1-2b",
			TEXT_TO_SPEECH: "eliza-1-2b",
			TRANSCRIPTION: "eliza-1-2b",
		});
	});

	it("does not recommend hand-installed text-gen models when no Eliza-1 default qualifies", () => {
		const installed: InstalledModel[] = [
			makeModel({
				id: "llama-3.2-1b-instruct",
				source: "external-scan",
				sizeBytes: 800_000_000,
			}),
			makeModel({
				id: "bge-small-en-v1.5",
				source: "external-scan",
				sizeBytes: 100_000_000,
			}),
		];
		expect(buildRecommendedAssignments(installed)).toEqual({});
	});

	it("does not promote an embedding model to TEXT_LARGE in the fallback path", () => {
		const installed: InstalledModel[] = [
			makeModel({
				id: "bge-small-en-v1.5",
				source: "external-scan",
				sizeBytes: 100_000_000,
			}),
		];
		expect(buildRecommendedAssignments(installed)).toEqual({});
	});

	it("keeps multiple custom text models search-only instead of picking a largest fallback", () => {
		const installed: InstalledModel[] = [
			makeModel({
				id: "qwen-2.5-1.5b",
				source: "external-scan",
				sizeBytes: 1_500_000_000,
			}),
			makeModel({
				id: "llama-3.2-3b-instruct",
				source: "external-scan",
				sizeBytes: 3_000_000_000,
			}),
			makeModel({
				id: "nomic-embed-text",
				source: "external-scan",
				sizeBytes: 200_000_000,
			}),
		];
		expect(buildRecommendedAssignments(installed)).toEqual({});
	});
});
