/** Exercises both provider-success crash windows through real private/public journals and loopback HTTP. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuditSink,
  type ClaudeCompletionResult,
  type CompletionRunner,
  canonicalizeChatCompletion,
  DurableAuditStore,
  type GatewayAuditRecord,
  LogicalRequestAllocator,
  ReplayJournal,
  startClaudeSubscriptionGateway,
} from "../src/index.js";

const TOKEN = "eliza-replay-token-0000000000000000000000000001";

describe("gateway replay", () => {
  it("commits the private success before awaiting public audit and HTTP delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-ordering-"));
    const journalPath = join(directory, "responses.jsonl");
    let enterAudit: (() => void) | null = null;
    const auditEntered = new Promise<void>((resolve) => {
      enterAudit = resolve;
    });
    let releaseAudit: (() => void) | null = null;
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const auditSink: AuditSink = {
      append(_record: GatewayAuditRecord) {
        enterAudit?.();
        return auditReleased;
      },
    };

    try {
      const journal = await ReplayJournal.open(journalPath);
      const gateway = await startClaudeSubscriptionGateway({
        completionRunner: {
          async complete() {
            return completionResult();
          },
        },
        replayJournal: journal,
        auditSink,
        benchmarkNamespace: "ordering-test",
        harnessTokens: { eliza: TOKEN },
      });
      let delivered = false;
      const pendingResponse = request(gateway.baseUrl, {
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "Return PONG" }],
      }).then((response) => {
        delivered = true;
        return response;
      });

      await auditEntered;
      expect((await readFile(journalPath, "utf8")).trim()).not.toBe("");
      await Promise.resolve();
      expect(delivered).toBe(false);
      releaseAudit?.();
      expect((await pendingResponse).status).toBe(200);
      await gateway.close();
      await journal.close();
    } finally {
      releaseAudit?.();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconstructs missing audit, then emits only replay delivery without a second provider call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-replay-"));
    const auditPath = join(directory, "audit.jsonl");
    const journalPath = join(directory, "responses.jsonl");
    const requestBody = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "Return PONG" }],
    };
    const canonical = canonicalizeChatCompletion(requestBody);
    const logical = new LogicalRequestAllocator("replay-test").allocate(
      "eliza",
      canonical,
    );
    const result = completionResult();
    let providerCalls = 0;
    const runner: CompletionRunner = {
      async complete() {
        providerCalls += 1;
        throw new Error("provider must not run during replay");
      },
    };

    try {
      const crashJournal = await ReplayJournal.open(journalPath);
      await crashJournal.commitSuccess(logical, {
        requestId: logical.requestId,
        created: 1_700_000_000,
        queueWaitMs: 0,
        result,
      });
      await crashJournal.close();

      const firstJournal = await ReplayJournal.open(journalPath);
      const firstAudit = await DurableAuditStore.open(auditPath);
      const firstGateway = await startClaudeSubscriptionGateway({
        completionRunner: runner,
        replayJournal: firstJournal,
        auditSink: firstAudit,
        benchmarkNamespace: "replay-test",
        harnessTokens: { eliza: TOKEN },
      });
      const firstResponse = await request(firstGateway.baseUrl, requestBody);
      expect(firstResponse.status).toBe(200);
      const firstBody = await firstResponse.json();
      expect(providerCalls).toBe(0);
      const firstRows = await auditRows(auditPath);
      expect(firstRows).toHaveLength(1);
      expect(firstRows[0]).toMatchObject({
        audit_event: "logical_completion",
        execution_origin: "replay",
        request_id: logical.requestId,
      });
      await firstGateway.close();
      await firstJournal.close();
      await firstAudit.close();

      const secondJournal = await ReplayJournal.open(journalPath);
      const secondAudit = await DurableAuditStore.open(auditPath);
      const secondGateway = await startClaudeSubscriptionGateway({
        completionRunner: runner,
        replayJournal: secondJournal,
        auditSink: secondAudit,
        benchmarkNamespace: "replay-test",
        harnessTokens: { eliza: TOKEN },
      });
      const secondResponse = await request(secondGateway.baseUrl, requestBody);
      expect(secondResponse.status).toBe(200);
      expect(await secondResponse.json()).toEqual(firstBody);
      expect(providerCalls).toBe(0);
      const secondRows = await auditRows(auditPath);
      expect(secondRows).toHaveLength(2);
      expect(secondRows[1]).toMatchObject({
        audit_event: "replay_delivery",
        execution_origin: "replay",
        delivery_attempt: null,
      });
      await secondGateway.close();
      await secondJournal.close();
      await secondAudit.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function request(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function auditRows(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function completionResult(): ClaudeCompletionResult {
  return {
    text: "PONG",
    toolCalls: [],
    model: "claude-opus-4-8-actual",
    claudeCodeVersion: "test-cli",
    sdkApiKeySource: "none",
    resultSubtype: "success",
    terminalReason: "completed",
    subscriptionType: "Claude Max",
    credentialEpochHmacSha256: "1".repeat(64),
    credentialTierHmacSha256: "2".repeat(64),
    credentialCapabilityHmacSha256: "3".repeat(64),
    usage: {
      inputTokens: 11,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
    },
  };
}
