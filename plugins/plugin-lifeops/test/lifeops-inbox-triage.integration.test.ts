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

  // PRD Journey #7 — Priority Ranking
  // PRD ref: packages/docs/prd-lifeops-executive-assistant.md
  //   Suite B (`ea.inbox.daily-brief-ranks-urgent-before-low-priority`).
  // Lane: PR (in-process) + post-merge (in-process)
  it("ranks high-urgency triage entries before low-urgency ones in unresolved/digest queries", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const repo = new InboxTriageRepository(runtimeResult.runtime);

    // Seed: low-urgency newsletter, then high-urgency client request.
    // The repository SQL `ORDER BY CASE urgency WHEN 'high' THEN 0 ...`
    // must surface the high-urgency entry first regardless of insert order.
    await repo.storeTriage({
      source: "gmail",
      channelName: "Newsletter Weekly",
      channelType: "email",
      classification: "fyi",
      urgency: "low",
      confidence: 0.6,
      snippet: "Weekly product newsletter",
    });
    await repo.storeTriage({
      source: "gmail",
      channelName: "Acme client thread",
      channelType: "email",
      classification: "needs_reply",
      urgency: "high",
      confidence: 0.95,
      snippet: "Need decision before EOD",
    });

    const unresolved = await repo.getUnresolved();
    expect(unresolved.length).toBe(2);
    expect(unresolved[0]?.urgency).toBe("high");
    expect(unresolved[0]?.snippet).toContain("decision");
    expect(unresolved[1]?.urgency).toBe("low");

    const sinceIso = new Date(Date.now() - 60_000).toISOString();
    const digest = await repo.getRecentForDigest(sinceIso);
    expect(digest.length).toBe(2);
    expect(digest[0]?.urgency).toBe("high");
    expect(digest[1]?.urgency).toBe("low");
  });
});
