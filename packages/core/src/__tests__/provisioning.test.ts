import { describe, expect, it, vi } from "vitest";
import { ensureEmbeddingDimension } from "../provisioning";
import { createMockRuntime } from "../testing/mock-runtime";
import type { IAgentRuntime } from "../types/runtime";

/**
 * ensureEmbeddingDimension in core/provisioning.ts — the EMBEDDING_DIMENSION-
 * setting probe used by the daemon-composition path (createRuntimes({ provision:
 * true }) → provisionAgent). It has two silent early-returns — no TEXT_EMBEDDING
 * model, and an unset/invalid EMBEDDING_DIMENSION — plus the happy path that
 * snaps the storage column to the configured width. None were covered; a
 * regression dropping the model-or-dim guard would call
 * adapter.ensureEmbeddingDimension with a wrong/default width and ship silently.
 *
 * NOTE: managed cloud agents do NOT take this path — they boot
 * `new AgentRuntime(...)` + `runtime.initialize()` and snap the column via
 * `runtime.ensureEmbeddingDimension()`. #8769 (the managed-boot ordering bug) is
 * covered by packages/agent/src/runtime/eliza-embedding-boot-order.test.ts, not
 * here; this file is valid standalone coverage for the daemon-path function.
 */
function makeRuntime(opts: {
	hasModel: boolean;
	embeddingDimension?: string | number;
	embeddingDimensions?: string | number;
}): { runtime: IAgentRuntime; ensureDim: ReturnType<typeof vi.fn> } {
	const ensureDim = vi.fn(async () => true);
	const runtime = createMockRuntime({
		agentId: "00000000-0000-0000-0000-000000000001",
		adapter: { ensureEmbeddingDimension: ensureDim },
		getModel: vi.fn(() => (opts.hasModel ? async () => [] : undefined)),
		getSetting: vi.fn((key: string) => {
			if (key === "EMBEDDING_DIMENSION") return opts.embeddingDimension;
			if (key === "EMBEDDING_DIMENSIONS") return opts.embeddingDimensions;
			return undefined;
		}),
	});
	return { runtime, ensureDim };
}

describe("ensureEmbeddingDimension (core/provisioning.ts daemon-composition probe)", () => {
	it("skips when no TEXT_EMBEDDING model is registered", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: false,
			embeddingDimension: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).not.toHaveBeenCalled();
	});

	it("skips when EMBEDDING_DIMENSION is non-numeric", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "abc",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).not.toHaveBeenCalled();
	});

	it("skips when EMBEDDING_DIMENSION is <= 0", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "0",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).not.toHaveBeenCalled();
	});

	it("snaps the column to the configured dimension when a model + valid dim are present", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledTimes(1);
		expect(ensureDim).toHaveBeenCalledWith(1536);
	});

	it("accepts a numeric EMBEDDING_DIMENSION setting", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: 768,
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledWith(768);
	});

	it("falls back to EMBEDDING_DIMENSIONS (plural) when EMBEDDING_DIMENSION is unset", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimensions: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledWith(1536);
	});

	it("prefers the explicit singular EMBEDDING_DIMENSION when the two conflict (and logs a conflict warning)", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "384",
			embeddingDimensions: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		// the explicit singular provisioning setting wins for the DB column; the
		// operator-facing conflict warning is emitted as a side-effect (visible in
		// the logger output) so a 384-vs-1536 mismatch can't silently break memory.
		expect(ensureDim).toHaveBeenCalledWith(384);
	});

	it("uses the agreed value when singular and plural match", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "1536",
			embeddingDimensions: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledWith(1536);
	});
});
