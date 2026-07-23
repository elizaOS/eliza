/** Verifies crash repair, committed-corruption rejection, and bounded audit cursor idempotence on real files. */

import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableAuditStore,
  type GatewayAuditRecord,
  HashChainCorruptionError,
  HashChainedJsonl,
} from "../src/index.js";

describe("HashChainedJsonl", () => {
  it("appends privately without replacing the inode and repairs only a torn tail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-chain-"));
    const target = join(directory, "audit.jsonl");
    try {
      const first = await HashChainedJsonl.open(target, {
        sequenceField: "audit_sequence",
      });
      await first.append({ value: "one" });
      const prefix = await readFile(target, "utf8");
      const inode = (await stat(target)).ino;
      await first.close();

      const second = await HashChainedJsonl.open(target, {
        sequenceField: "audit_sequence",
      });
      await second.append({ value: "two" });
      await second.close();
      expect((await stat(target)).ino).toBe(inode);
      expect((await readFile(target, "utf8")).startsWith(prefix)).toBe(true);
      expect(Number((await stat(target)).mode) & 0o777).toBe(0o600);

      await appendFile(target, '{"torn":', "utf8");
      const repaired = await HashChainedJsonl.open(target, {
        sequenceField: "audit_sequence",
      });
      expect(repaired.stats()).toEqual({ total: 2 });
      await repaired.close();
      const repairedText = await readFile(target, "utf8");
      expect(repairedText.endsWith("\n")).toBe(true);
      expect(repairedText).not.toContain('"torn"');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects corruption in a newline-terminated committed record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-corrupt-"));
    const target = join(directory, "audit.jsonl");
    try {
      const store = await HashChainedJsonl.open(target, {
        sequenceField: "audit_sequence",
      });
      await store.append({ value: "one" });
      await store.append({ value: "two" });
      await store.close();
      const lines = (await readFile(target, "utf8")).trimEnd().split("\n");
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      first.value = "tampered";
      lines[0] = JSON.stringify(first);
      await writeFile(target, `${lines.join("\n")}\n`, { mode: 0o600 });

      await expect(
        HashChainedJsonl.open(target, { sequenceField: "audit_sequence" }),
      ).rejects.toBeInstanceOf(HashChainCorruptionError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("DurableAuditStore lane cursor", () => {
  it("caches repeated ordinal lookups and rejects a conflicting key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-audit-cursor-"));
    const target = join(directory, "audit.jsonl");
    const key = "a".repeat(64);
    try {
      const store = await DurableAuditStore.open(target);
      await expect(store.hasLogicalCompletion("eliza", 0, key)).resolves.toBe(
        false,
      );
      await expect(store.hasLogicalCompletion("eliza", 0, key)).resolves.toBe(
        false,
      );
      await store.append(auditRecord(key));
      await expect(store.hasLogicalCompletion("eliza", 0, key)).resolves.toBe(
        true,
      );
      await expect(
        store.hasLogicalCompletion("eliza", 0, "b".repeat(64)),
      ).rejects.toThrow("different key");
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function auditRecord(logicalKeySha256: string): GatewayAuditRecord {
  return {
    requestId: `logical_${logicalKeySha256}`,
    recordedAt: "2026-07-21T00:00:00.000Z",
    harness: "eliza",
    transport: "claude-agent-sdk",
    credentialSource: "claude-code-managed",
    sdkVersion: "0.3.200",
    sdkApiKeySource: "none",
    freshSession: true,
    toolExecution: "capture-only",
    serializer: "openai-full-history-v1",
    responseMode: "json",
    modelRequested: "claude-opus-4-8",
    modelEffective: "claude-opus-4-8",
    reasoningEffort: null,
    claudeCodeVersion: "test",
    messageCount: 1,
    messageRoles: ["user"],
    toolNames: [],
    toolChoice: "none",
    parallelToolCalls: true,
    toolCallNames: [],
    promptSha256: "b".repeat(64),
    systemPromptSha256: "c".repeat(64),
    toolSchemaSha256: "d".repeat(64),
    toolSchemaSha256ByName: {},
    requestSha256: "e".repeat(64),
    contentAttestation: null,
    queueWaitMs: 0,
    serviceMs: 1,
    status: "succeeded",
    finishReason: "stop",
    resultSubtype: "success",
    terminalReason: "completed",
    unappliedParameters: [],
    errorCode: null,
    logicalNamespaceSha256: "f".repeat(64),
    logicalOrdinal: 0,
    logicalKeySha256,
    deliveryAttempt: 1,
    executionOrigin: "original",
    auditEvent: "logical_completion",
    credentialEpochHmacSha256: "1".repeat(64),
    credentialTierHmacSha256: "2".repeat(64),
    credentialCapabilityHmacSha256: "3".repeat(64),
    retryAt: null,
    pauseReason: null,
  };
}
