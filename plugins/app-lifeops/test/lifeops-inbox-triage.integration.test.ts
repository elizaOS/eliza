import { afterEach, describe, expect, it } from "vitest";
import { InboxTriageRepository } from "../src/inbox/repository.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

describe("LifeOps inbox triage schema bootstrap", () => {
  let runtimeResult: Awaited<
    ReturnType<typeof createLifeOpsTestRuntime>
  > | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("creates inbox triage tables on a fresh runtime so digest queries succeed", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const repo = new InboxTriageRepository(runtimeResult.runtime);
    const sinceIso = new Date().toISOString();

    await expect(repo.getRecentForDigest(sinceIso)).resolves.toEqual([]);
    await expect(repo.getUnresolved()).resolves.toEqual([]);
    await expect(repo.getExamples(3)).resolves.toEqual([]);
  });

  it("persists triage examples with object context instead of nullable placeholders", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const repo = new InboxTriageRepository(runtimeResult.runtime);

    const stored = await repo.storeExample({
      source: "telegram",
      snippet: "please confirm",
      classification: "needs_reply",
      ownerAction: "confirmed",
    });

    expect(stored.contextJson).toEqual({});
    await expect(repo.getExamples(1)).resolves.toMatchObject([
      {
        source: "telegram",
        contextJson: {},
      },
    ]);
  });

  it("registers a client_chat send handler so inbox digests do not crash delivery", async () => {
    runtimeResult = await createLifeOpsTestRuntime();

    await expect(
      runtimeResult.runtime.sendMessageToTarget(
        {
          source: "client_chat",
          entityId: runtimeResult.runtime.agentId,
        },
        {
          text: "digest",
          source: "client_chat",
        },
      ),
    ).resolves.toBeUndefined();
  });
});
