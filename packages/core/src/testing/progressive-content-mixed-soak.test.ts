/** Verifies mixed-family scheduling, evidence ineligibility, and exact target coverage deterministically. */

import { describe, expect, it } from "vitest";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import {
	PROGRESSIVE_CONTENT_SOAK_FAMILIES,
	type ProgressiveContentSoakFamily,
	runProgressiveContentMixedSoakContract,
} from "./progressive-content-mixed-soak";

const stableResource = {
	rssBytes: 100 * 1024 * 1024,
	heapUsedBytes: 40 * 1024 * 1024,
	externalBytes: 8 * 1024 * 1024,
	arrayBuffersBytes: 4 * 1024 * 1024,
	fileDescriptors: 12,
	temporaryArtifacts: 0,
	databaseRows: 0,
	walBytes: 0,
};

function targets(families: readonly ProgressiveContentSoakFamily[]) {
	const realizations = {
		file: ["filesystem", "native-bytes"],
		document: ["document-store", "typed-rejection"],
		memory: ["memory-store", "typed-rejection"],
		email: ["message-store", "typed-rejection"],
		attachment: ["content-addressed-media", "native-bytes"],
		"tool-output": ["filesystem", "native-bytes"],
	} as const;
	return families.map((family) => ({
		family,
		authoritativeStore: realizations[family][0],
		binaryPolicy: realizations[family][1],
		productionMethod: `${family}-native-realization`,
		create: () => {
			const base = progressiveConformanceAdapter();
			const fixture = progressiveConformanceFixture();
			const kind = family === "tool-output" ? "tool-result" : family;
			return {
				object: { ...fixture.object, id: `${family}-object`, family: kind },
				adapter: {
					...base,
					adapterId: `${family}-production-test-adapter`,
					async read(request: Parameters<typeof base.read>[0]) {
						const page = await base.read({
							...request,
							objectId: fixture.object.id,
						});
						return {
							...page,
							view: {
								...page.view,
								reference: { ...page.view.reference, kind },
							},
						};
					},
				},
			};
		},
	}));
}

describe("mixed progressive-content soak", () => {
	it("round-robins every family and marks shortened injected runs ineligible", async () => {
		let tick = 0;
		const report = await runProgressiveContentMixedSoakContract({
			commit: "a".repeat(40),
			corpusManifestSha256: "b".repeat(64),
			targets: targets(PROGRESSIVE_CONTENT_SOAK_FAMILIES),
			measureResources: () => stableResource,
			policy: {
				requiredDurationMs: 1,
				requiredOperations: 12,
				batchOperations: 12,
				now: () => tick++,
				clockSource: "injected-contract-test",
			},
		});
		expect(report.status).toBe("passed");
		expect(report.evidenceEligible).toBe(false);
		expect(report.families.map(({ family }) => family)).toEqual(
			PROGRESSIVE_CONTENT_SOAK_FAMILIES,
		);
		expect(report.families.map(({ operations }) => operations)).toEqual([
			2, 2, 2, 2, 2, 2,
		]);
		expect(report.families.every(({ failures }) => failures.length === 0)).toBe(
			true,
		);
		expect(report.positiveLeakControlDetected).toBe(true);
	});

	it.each([
		["empty", []],
		["partial", PROGRESSIVE_CONTENT_SOAK_FAMILIES.slice(0, 5)],
		[
			"duplicate",
			[
				...PROGRESSIVE_CONTENT_SOAK_FAMILIES.slice(0, 5),
				"file",
			] as readonly ProgressiveContentSoakFamily[],
		],
	])("rejects %s target coverage", async (_label, families) => {
		await expect(
			runProgressiveContentMixedSoakContract({
				commit: "a".repeat(40),
				corpusManifestSha256: "b".repeat(64),
				targets: targets(families),
				measureResources: () => stableResource,
				policy: {
					requiredDurationMs: 1,
					requiredOperations: 1,
					batchOperations: 1,
					now: () => 1,
					clockSource: "injected-contract-test",
				},
			}),
		).rejects.toThrow(/exactly six|required family/u);
	});
});
