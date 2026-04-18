import { afterEach, describe, expect, it } from "vitest";
import { InboxTriageRepository } from "../src/inbox/repository.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

describe("LifeOps inbox triage schema bootstrap", () => {
  let runtimeResult: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | null =
    null;

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

  it("registers a client_chat send handler for integration runtimes", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    await expect(
      runtimeResult.runtime.sendMessageToTarget(
        { source: "client_chat", entityId: runtimeResult.runtime.agentId },
        { text: "ping" },
      ),
    ).resolves.toBeUndefined();
  });
});
