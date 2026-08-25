/** Exercises the unified target contract against a deterministic real-byte lifecycle. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildReadView } from "../types/content";
import type { ProgressiveContentTarget } from "./progressive-content-target";
import { runProgressiveContentTargetConformance } from "./progressive-content-target";

class TargetError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

function targetFixture(): ProgressiveContentTarget {
	const bytes = Buffer.from("beginning 世界🙂 middle ending".repeat(8_192));
	const revision = createHash("sha256").update(bytes).digest("hex");
	let present = true;
	let generation = 1;
	return {
		family: "file",
		object: {
			id: "target-object",
			family: "file",
			byteLength: bytes.byteLength,
			sourceSha256: revision,
			revision,
			authorizationScope: "room:authorized",
			canaries: [],
		},
		realization: {
			reference: {
				kind: "file",
				ref: "file:opaque-target",
				revision,
				resumability: "restart-safe",
			},
			sourceRevision: revision,
			authorizationMode: "principal",
			authorizationScopeDigest: createHash("sha256")
				.update("room:authorized")
				.digest("hex"),
			cleanupIdentity: "target:opaque-target",
			resolverBindingSha256: revision,
		},
		async read({ access, offset, limit, expectedRevision }) {
			if (!present) throw new TargetError("CONTENT_NOT_FOUND");
			if (access === "unauthorized")
				throw new TargetError("CONTENT_ACCESS_DENIED");
			if (access === "isolated") throw new TargetError("CONTENT_NOT_FOUND");
			if (expectedRevision && expectedRevision !== revision)
				throw new TargetError("CONTENT_STALE_REVISION");
			const page = bytes.subarray(offset, offset + limit);
			const end = offset + page.byteLength;
			return {
				bytes: page,
				view: buildReadView({
					reference: this.realization.reference,
					slice: {
						range: { unit: "byte", start: offset, end, total: bytes.length },
						hasPrevious: offset > 0,
						hasMore: end < bytes.length,
						...(end < bytes.length ? { nextOffset: end } : {}),
						revision,
						completeness:
							end < bytes.length ? "partial-recoverable" : "complete",
						sliceSha256: createHash("sha256").update(page).digest("hex"),
					},
				}),
				sourceWork: {
					readCalls: 1,
					bytesRead: page.byteLength,
					rowsRead: 1,
					parentScans: 0,
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
				ownedBytes: present ? bytes.byteLength : 0,
				databaseRows: 0,
				temporaryArtifacts: 0,
				walBytes: 0,
			};
		},
		async cleanup() {
			present = false;
		},
	};
}

describe("progressive content target conformance", () => {
	it("derives restart, same-object access, isolation, and cleanup receipts", async () => {
		const result = await runProgressiveContentTargetConformance({
			manifestSha256: "a".repeat(64),
			adapterId: "production-target-fixture",
			target: targetFixture(),
		});
		expect(result.report.status).toBe("passed");
		expect(result.receipts.map(({ phase }) => phase)).toEqual([
			"realized",
			"authorization",
			"isolation",
			"restart",
			"cleanup",
			"cleanup",
		]);
		expect(result.receipts.every(({ status }) => status === "passed")).toBe(
			true,
		);
		expect(
			result.receipts.find(({ phase }) => phase === "restart")?.before
				.resolverGeneration,
		).not.toBe(
			result.receipts.find(({ phase }) => phase === "restart")?.after
				.resolverGeneration,
		);
	});

	it("fails when an isolated actor can resolve the target", async () => {
		const target = targetFixture();
		const read = target.read.bind(target);
		target.read = (input) =>
			read({
				...input,
				access: input.access === "isolated" ? "authorized" : input.access,
			});
		const result = await runProgressiveContentTargetConformance({
			manifestSha256: "b".repeat(64),
			adapterId: "isolation-bypass-mutant",
			target,
		});
		expect(result.report.status).toBe("failed");
		expect(result.report.failures).toContainEqual({
			vector: "target-isolation",
			message: "isolation receipt failed",
		});
	});
});
