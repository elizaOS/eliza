/**
 * Coverage for `ensureEmbeddingDimension` (core/provisioning.ts) — the daemon
 * composition-path probe that snaps the embedding storage column to the
 * configured width. Deterministic `createMockRuntime` with a mocked logger and
 * adapter; no live model or DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import type { IAgentRuntime } from "../types/runtime";

const warnSpy = vi.fn();
vi.mock("../logger", () => ({
	createLogger: () => ({
		warn: warnSpy,
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

// Import after the mock is registered so provisioning's module-local logger
// resolves to the spy above.
const { ensureEmbeddingDimension } = await import("../provisioning");

beforeEach(() => {
	warnSpy.mockClear();
});

/**
 * ensureEmbeddingDimension in core/provisioning.ts — the EMBEDDING_DIMENSION-
 * setting probe used by the daemon-composition path (createRuntimes({ provision:
 * true }) → provisionAgent). It has two silent early-returns — no TEXT_EMBEDDING
 * model, and an unset/invalid EMBEDDING_DIMENSION — plus the happy path that
 * snaps the storage column to the configured width. A regression dropping the
 * model-or-dim guard would call adapter.ensureEmbeddingDimension with a
 * wrong/default width and ship silently.
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

	it("falls back to EMBEDDING_DIMENSIONS (plural) when the singular key is unset", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimensions: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledWith(1536);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("prefers the plural EMBEDDING_DIMENSIONS on conflict and warns", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "384",
			embeddingDimensions: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		// Plural wins: the runtime embedder reads EMBEDDING_DIMENSIONS and emits
		// 1536-dim vectors, so the DB column must be sized to 1536, not 384.
		expect(ensureDim).toHaveBeenCalledWith(1536);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [ctx, msg] = warnSpy.mock.calls[0];
		expect(ctx).toMatchObject({ singular: 384, plural: 1536 });
		expect(msg).toContain("conflict");
	});

	it("uses the agreed value (no warning) when singular and plural match", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "1536",
			embeddingDimensions: "1536",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledWith(1536);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("uses singular when only singular is set", async () => {
		const { runtime, ensureDim } = makeRuntime({
			hasModel: true,
			embeddingDimension: "384",
		});
		await ensureEmbeddingDimension(runtime);
		expect(ensureDim).toHaveBeenCalledWith(384);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
