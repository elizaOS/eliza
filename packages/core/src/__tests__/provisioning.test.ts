import { describe, expect, it, vi } from "vitest";
import { ensureEmbeddingDimension } from "../provisioning";
import type { IAgentRuntime } from "../types/runtime";

/**
 * ensureEmbeddingDimension (the boot embedding-dim probe #8769 depends on) has
 * two silent early-returns — no TEXT_EMBEDDING model, and an unset/invalid
 * EMBEDDING_DIMENSION — plus the happy path that snaps the storage column to the
 * configured width. None were covered; a regression dropping the model-or-dim
 * guard would call adapter.ensureEmbeddingDimension with a wrong/default width
 * and ship silently.
 */
function makeRuntime(opts: {
  hasModel: boolean;
  embeddingDimension?: string | number;
}): { runtime: IAgentRuntime; ensureDim: ReturnType<typeof vi.fn> } {
  const ensureDim = vi.fn(async () => true);
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    adapter: { ensureEmbeddingDimension: ensureDim },
    getModel: vi.fn(() => (opts.hasModel ? async () => [] : undefined)),
    getSetting: vi.fn((key: string) =>
      key === "EMBEDDING_DIMENSION" ? opts.embeddingDimension : undefined,
    ),
  } as unknown as IAgentRuntime;
  return { runtime, ensureDim };
}

describe("ensureEmbeddingDimension (#8769 boot probe)", () => {
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
});
