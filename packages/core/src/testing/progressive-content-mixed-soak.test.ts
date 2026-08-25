/** Verifies mixed-family scheduling, evidence ineligibility, and exact target coverage deterministically. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import {
	PROGRESSIVE_CONTENT_SOAK_FAMILIES,
	PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS,
	type ProgressiveContentSoakFamily,
	type ProgressiveContentSoakLifecycleContract,
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

function measuredResource() {
	const usage = process.memoryUsage();
	return {
		...stableResource,
		rssBytes: usage.rss,
		heapUsedBytes: usage.heapUsed,
		externalBytes: usage.external,
		arrayBuffersBytes: usage.arrayBuffers,
	};
}

function targets(families: readonly ProgressiveContentSoakFamily[]) {
	const realizations = {
		file: ["filesystem", "typed-rejection"],
		document: ["document-store", "typed-rejection"],
		memory: ["memory-store", "typed-rejection"],
		email: ["message-store", "typed-rejection"],
		attachment: ["content-addressed-media", "native-bytes"],
		"tool-output": ["filesystem", "native-bytes"],
	} as const;
	return families.map((family) => ({
		family,
		adapterId: `${family}-production-adapter`,
		authoritativeStore: realizations[family][0],
		binaryPolicy: realizations[family][1],
		productionMethod: `${family}-native-realization`,
		create: () => {
			const base = progressiveConformanceAdapter();
			const fixture = progressiveConformanceFixture();
			const kind = family === "tool-output" ? "tool-result" : family;
			const object = {
				...fixture.object,
				id: `${family}-object`,
				family: kind,
			};
			let generation = 1;
			let present = true;
			return {
				family,
				object,
				realization: {
					reference: {
						kind,
						ref: `${kind}:opaque-soak-target`,
						revision: object.revision,
						resumability: "restart-safe",
					},
					sourceRevision: object.revision,
					authorizationMode: "principal",
					restartScope: "process",
					authorizationScopeDigest: createHash("sha256")
						.update(object.authorizationScope)
						.digest("hex"),
					cleanupIdentity: `${kind}:opaque-soak-target`,
					resolverBindingSha256: object.revision,
				},
				async read({ access, offset, limit, expectedRevision }) {
					if (!present) throw new Error("CONTENT_NOT_FOUND");
					if (access !== "authorized") throw new Error("CONTENT_ACCESS_DENIED");
					const page = await base.read({
						objectId: fixture.object.id,
						authorizationScope: fixture.object.authorizationScope,
						offset,
						limit,
						expectedRevision,
					});
					return {
						...page,
						view: {
							...page.view,
							reference: { ...page.view.reference, kind },
						},
					};
				},
				async restart() {
					generation += 1;
				},
				async inspect() {
					return {
						resolverGeneration: `generation:${generation}`,
						present,
						ownedBytes: present ? object.byteLength : 0,
						databaseRows: 0,
						temporaryArtifacts: 0,
						walBytes: 0,
					};
				},
				async cleanup() {
					await base.cleanup(fixture.object.id);
					present = false;
				},
			};
		},
	}));
}

function lifecycle(
	unsupported?: "eviction",
): ProgressiveContentSoakLifecycleContract {
	const expectedCodes = {
		abort: "CONTENT_READ_CANCELLED",
		revoke: "CONTENT_ACCESS_REVOKED",
		mutate: "CONTENT_STALE_REVISION",
		expire: "CONTENT_EXPIRED",
		compaction: "CONTENT_MANIFEST_COMMIT_FAILED",
		eviction: "CONTENT_CONTINUITY_LEDGER_MISMATCH",
	} as const;
	return {
		declarations: PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.map((id) => {
			if (id === "restart") {
				return { id, semantics: "target-transition" as const };
			}
			if (id === unsupported) {
				return {
					id,
					semantics: "unsupported" as const,
					reason: "production eviction transition is not implemented",
				};
			}
			const expectedCode = expectedCodes[id];
			return {
				id,
				semantics:
					id === "eviction"
						? ("mutant-rejection" as const)
						: ("fault-rejection" as const),
				expectedCode,
				executor: {
					execute() {
						throw Object.assign(new Error(expectedCode), {
							code: expectedCode,
						});
					},
					observeEffects: () => [],
				},
			};
		}),
	};
}

describe("mixed progressive-content soak", () => {
	it("round-robins every family and marks shortened injected runs ineligible", async () => {
		let tick = 0;
		const report = await runProgressiveContentMixedSoakContract({
			commit: "a".repeat(40),
			corpusManifestSha256: "b".repeat(64),
			targets: targets(PROGRESSIVE_CONTENT_SOAK_FAMILIES),
			measureResources: measuredResource,
			lifecycle: lifecycle(),
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
		expect(
			report.families.every(({ cleanupVerified }) => cleanupVerified),
		).toBe(true);
		expect(report.positiveLeakControlDetected).toBe(true);
		expect(report.lifecycle).toMatchObject({
			status: "passed",
			completedCycles: 1,
			required: PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS,
		});
		expect(report.lifecycle.results).toHaveLength(
			PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.length,
		);
		expect(
			report.lifecycle.results.find(({ id }) => id === "restart"),
		).toMatchObject({
			semantics: "target-transition",
			status: "passed",
			targetFamily: "file",
			beforeGeneration: "generation:1",
			afterGeneration: "generation:2",
		});
	});

	it("reports unsupported lifecycle semantics and fails the soak closed", async () => {
		let tick = 0;
		const report = await runProgressiveContentMixedSoakContract({
			commit: "a".repeat(40),
			corpusManifestSha256: "b".repeat(64),
			targets: targets(PROGRESSIVE_CONTENT_SOAK_FAMILIES),
			measureResources: measuredResource,
			lifecycle: lifecycle("eviction"),
			policy: {
				requiredDurationMs: 1,
				requiredOperations: 6,
				batchOperations: 6,
				now: () => tick++,
				clockSource: "injected-contract-test",
			},
		});
		expect(report.status).toBe("failed");
		expect(report.evidenceEligible).toBe(false);
		expect(report.lifecycle.status).toBe("failed");
		expect(
			report.lifecycle.results.find(({ id }) => id === "eviction"),
		).toMatchObject({
			semantics: "unsupported",
			status: "unsupported",
			reason: "production eviction transition is not implemented",
		});
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
				lifecycle: lifecycle(),
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

	it("rejects lifecycle declarations that do not cover the closed catalog", async () => {
		await expect(
			runProgressiveContentMixedSoakContract({
				commit: "a".repeat(40),
				corpusManifestSha256: "b".repeat(64),
				targets: targets(PROGRESSIVE_CONTENT_SOAK_FAMILIES),
				measureResources: () => stableResource,
				lifecycle: {
					declarations: lifecycle().declarations.slice(0, -1),
				},
				policy: {
					requiredDurationMs: 1,
					requiredOperations: 1,
					batchOperations: 1,
					now: () => 1,
					clockSource: "injected-contract-test",
				},
			}),
		).rejects.toThrow(/exactly seven/u);
	});

	it("rejects lifecycle declarations that relabel a fixed rejection", async () => {
		const changed = lifecycle().declarations.map((declaration) =>
			declaration.id === "abort" && declaration.semantics !== "unsupported"
				? { ...declaration, expectedCode: "CONTENT_READ_FAILED" }
				: declaration,
		);
		await expect(
			runProgressiveContentMixedSoakContract({
				commit: "a".repeat(40),
				corpusManifestSha256: "b".repeat(64),
				targets: targets(PROGRESSIVE_CONTENT_SOAK_FAMILIES),
				measureResources: () => stableResource,
				lifecycle: { declarations: changed },
				policy: {
					requiredDurationMs: 1,
					requiredOperations: 1,
					batchOperations: 1,
					now: () => 1,
					clockSource: "injected-contract-test",
				},
			}),
		).rejects.toThrow(/fixed rejection contract/u);
	});
});
