/** Exercises confidential dispatch admission against real SQLite transactions and reopen. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  ConfidentialInferenceAuthority,
  fetchWithConfidentialInference,
  runWithConfidentialInference,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, expect, it } from "vitest";
import { createConfidentialSQLiteAudit } from "./confidential-sqlite-audit";

const opened: SQLiteDatabaseAdapter[] = [];
const directories: string[] = [];
const uuid = () => randomUUID() as UUID;
const forbiddenFetch = Object.assign(
  async () => {
    throw new Error("Ordinary transport must not run");
  },
  { preconnect: fetch.preconnect },
);
afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "confidential-audit-"));
  directories.push(directory);
  const identity = { agentId: uuid(), entityId: uuid(), roomId: uuid() };
  const path = join(directory, "agent.sqlite");
  const adapter = SQLiteDatabaseAdapter.create(path, identity.agentId);
  opened.push(adapter);
  await adapter.initialize();
  await adapter.createAgents([{ id: identity.agentId, name: "Synthetic" }]);
  await adapter.createEntities([
    {
      id: identity.entityId,
      agentId: identity.agentId,
      names: ["Audit actor"],
    },
  ]);
  await adapter.createRooms([
    {
      id: identity.roomId,
      agentId: identity.agentId,
      type: ChannelType.DM,
      source: "audit",
    },
  ]);
  return { adapter, identity, path };
}
const evidence = {
  evidenceDigest: "a".repeat(64),
  connectionBindingDigest: "b".repeat(64),
};

it("withholds application dispatch when the durable database becomes unavailable", async () => {
  const { adapter, identity } = await fixture();
  const audit = await createConfidentialSQLiteAudit(adapter, identity);
  const endpoint = "https://synthetic.example.test/v1/chat/completions";
  const expiresAt = Date.now() + 60_000;
  let dispatched = false;
  const handler = () =>
    fetchWithConfidentialInference(
      endpoint,
      {
        method: "POST",
        body: JSON.stringify({ model: "reviewed" }),
      },
      forbiddenFetch,
    );
  const authority = new ConfidentialInferenceAuthority({
    handlers: [handler],
    audit,
    currentProfile: () => ({
      revision: "signed-policy",
      expiresAt,
      routes: [
        {
          id: "primary",
          endpoint,
          model: "reviewed",
          modelTypes: ["TEXT_LARGE"],
        },
      ],
    }),
    transport: async (_url, _request, context) => {
      await context.beforeDispatch(evidence);
      dispatched = true;
      return new Response("must not arrive");
    },
  });
  await adapter.close();
  await expect(
    runWithConfidentialInference(
      authority,
      {
        agentId: identity.agentId,
        modelType: "TEXT_LARGE",
        handler,
      },
      handler,
    ),
  ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_AUDIT_UNAVAILABLE" });
  expect(dispatched).toBe(false);
});

it("commits before transport dispatch and preserves only metadata through actual reopen", async () => {
  const { adapter, identity, path } = await fixture();
  const audit = await createConfidentialSQLiteAudit(adapter, identity);
  const endpoint = "https://synthetic.example.test/v1/chat/completions";
  const handler = async () =>
    fetchWithConfidentialInference(
      endpoint,
      {
        method: "POST",
        headers: { authorization: "synthetic-secret" },
        body: JSON.stringify({
          model: "reviewed",
          messages: [{ content: "synthetic-private-content" }],
        }),
      },
      forbiddenFetch,
    );
  let dispatched = 0;
  const expiresAt = Date.now() + 60_000;
  const authority = new ConfidentialInferenceAuthority({
    handlers: [handler],
    audit,
    currentProfile: () => ({
      revision: "signed-policy",
      expiresAt,
      routes: [
        {
          id: "primary",
          endpoint,
          model: "reviewed",
          modelTypes: ["TEXT_LARGE"],
        },
      ],
    }),
    transport: async (_url, _request, context) => {
      await context.beforeDispatch(evidence);
      const logs = await adapter.getLogs({ type: "confidential_inference" });
      expect(logs.map((log) => log.body.metadata?.phase)).toEqual([
        "dispatch_intent",
      ]);
      dispatched++;
      return new Response("synthetic-response");
    },
  });
  expect(
    await (
      await runWithConfidentialInference(
        authority,
        {
          agentId: identity.agentId,
          modelType: "TEXT_LARGE",
          handler,
        },
        handler,
      )
    ).text(),
  ).toBe("synthetic-response");
  expect(dispatched).toBe(1);
  await adapter.close();
  const restored = SQLiteDatabaseAdapter.create(path, identity.agentId);
  opened.push(restored);
  await restored.initialize();
  const logs = await restored.getLogs({ type: "confidential_inference" });
  expect(logs.map((log) => log.body.metadata?.phase).sort()).toEqual([
    "dispatch_intent",
    "response_headers",
  ]);
  expect(
    logs.every(
      (log) =>
        log.entityId === identity.entityId && log.roomId === identity.roomId,
    ),
  ).toBe(true);
  expect(
    logs.every(
      (log) => log.body.metadata?.evidenceDigest === evidence.evidenceDigest,
    ),
  ).toBe(true);
  expect(JSON.stringify(logs)).not.toMatch(
    /synthetic-secret|synthetic-private-content|synthetic-response/,
  );
});

it("rejects missing actors before admission and deleted actors before the next commit", async () => {
  const { adapter, identity } = await fixture();
  await expect(
    createConfidentialSQLiteAudit(adapter, { ...identity, entityId: uuid() }),
  ).rejects.toThrow();
  const audit = await createConfidentialSQLiteAudit(adapter, identity);
  await adapter.deleteEntities([identity.entityId]);
  await expect(
    audit.append({
      attemptId: randomUUID(),
      agentId: identity.agentId,
      modelType: "TEXT_LARGE",
      policyRevision: "revision",
      routeId: "primary",
      timestamp: Date.now(),
      phase: "dispatch_intent",
      ...evidence,
    }),
  ).rejects.toThrow();
  expect(await adapter.getLogs({ type: "confidential_inference" })).toEqual([]);
});

it("rejects another agent, unverified dispatch and unexpected payload fields without persisting them", async () => {
  const { adapter, identity } = await fixture();
  const audit = await createConfidentialSQLiteAudit(adapter, identity);
  const record = {
    attemptId: randomUUID(),
    agentId: identity.agentId,
    modelType: "TEXT_LARGE",
    policyRevision: "revision",
    routeId: "primary",
    timestamp: Date.now(),
    phase: "dispatch_intent" as const,
  };
  await expect(
    audit.append({ ...record, ...evidence, agentId: uuid() }),
  ).rejects.toThrow();
  await expect(audit.append(record)).rejects.toThrow();
  const unexpected = {
    ...record,
    ...evidence,
    prompt: "synthetic-private-content",
  };
  await expect(audit.append(unexpected)).rejects.toThrow();
  expect(await adapter.getLogs({ type: "confidential_inference" })).toEqual([]);
});
