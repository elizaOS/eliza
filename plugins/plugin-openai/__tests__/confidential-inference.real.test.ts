/** Exercises real runtime dispatch and OpenAI-compatible HTTP admission with
 * loopback servers and durable audit writes in the existing PGlite adapter.
 * This does not certify the separately required SQLite agent-storage migration.
 */
import { createServer, type Server } from "node:http";
import { generateText } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRuntime } from "../../../packages/core/src/runtime";
import {
  type ConfidentialInferenceAuditRecord,
  ConfidentialInferenceAuthority,
  type ConfidentialInferenceProfile,
  type ConfidentialInferenceTransport,
} from "../../../packages/core/src/security/confidential-inference";
import {
  ChannelType,
  type IAgentRuntime,
  ModelType,
  type UUID,
} from "../../../packages/core/src/types";
import { createIsolatedTestDatabase } from "../../plugin-sql/src/__tests__/test-helpers";
import { handleTextLarge } from "../models/text";
import { createOpenAIClient } from "../providers/openai";

const requests: Array<{ url: string; body: string }> = [];
let server: Server;
let endpoint: string;
let responseStatuses: number[] = [];
let onRequest: (() => void) | undefined;
let holdResponse = false;
let onResponseClosed: (() => void) | undefined;
let setup: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
const roomId = crypto.randomUUID() as UUID;
const entityId = crypto.randomUUID() as UUID;

async function handler(runtime: IAgentRuntime, params: Record<string, unknown>) {
  const result = await generateText({
    model: createOpenAIClient(runtime).chat(
      typeof params.model === "string" ? params.model : "approved-model"
    ),
    prompt: String(params.prompt),
    maxRetries: typeof params.retries === "number" ? params.retries : 0,
  });
  return result.text;
}

function fixture(
  options: {
    auditFailure?: boolean;
    outcomeAuditFailure?: boolean;
    afterAudit?: (record: ConfidentialInferenceAuditRecord) => void;
    route?: string;
    untrusted?: boolean;
    modelHandler?: typeof handler | typeof handleTextLarge;
    additionalHandlers?: Array<typeof handler>;
    transport?: ConfidentialInferenceTransport;
    redispatchPolicy?: "deny-after-authorization";
  } = {}
) {
  let profile: ConfidentialInferenceProfile = {
    revision: crypto.randomUUID(),
    expiresAt: Date.now() + 60_000,
    routes: [
      {
        id: "test-direct",
        endpoint: options.route ?? `${endpoint}/chat/completions`,
        model: "approved-model",
        modelTypes: [ModelType.TEXT_LARGE],
      },
    ],
  };
  const records: ConfidentialInferenceAuditRecord[] = [];
  const authority = new ConfidentialInferenceAuthority({
    handlers: options.untrusted
      ? []
      : [options.modelHandler ?? handler, ...(options.additionalHandlers ?? [])],
    currentProfile: () => profile,
    transport: options.transport,
    redispatchPolicy: options.redispatchPolicy,
    audit: {
      async append(record) {
        if (
          options.auditFailure ||
          (options.outcomeAuditFailure && record.phase === "response_headers")
        )
          throw new Error("synthetic storage unavailable");
        await setup.adapter.createLogs([
          { entityId, roomId, type: "processor_dispatch", body: { ...record } },
        ]);
        records.push(record);
        options.afterAudit?.(record);
      },
    },
  });
  const runtime = new AgentRuntime({
    agentId: setup.testAgentId,
    adapter: setup.adapter,
    confidentialInference: authority,
    settings: { OPENAI_API_KEY: "test-credential", OPENAI_BASE_URL: endpoint },
    logLevel: "fatal",
  });
  runtime.registerModel(
    ModelType.TEXT_LARGE,
    options.modelHandler ?? handler,
    "test-approved-handler",
    100
  );
  return {
    runtime,
    records,
    revoke: () => {
      profile = { ...profile, revision: "revoked", routes: [] };
    },
  };
}

describe("confidential inference actual dispatch", () => {
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      requests.push({ url: req.url ?? "", body });
      onRequest?.();
      const status = responseStatuses.shift() ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "synthetic rate limit", type: "rate_limit_error" } })
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (holdResponse) {
        res.on("close", () => onResponseClosed?.());
        res.write('{"pending":');
        return;
      }
      res.end(
        JSON.stringify({
          id: "test",
          object: "chat.completion",
          created: 1,
          model: "approved-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "complete reply" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback address unavailable");
    endpoint = `http://127.0.0.1:${address.port}/v1`;
    setup = await createIsolatedTestDatabase("confidential-inference");
    await setup.adapter.createEntities([
      {
        id: entityId,
        agentId: setup.testAgentId,
        names: ["Synthetic audit actor"],
      },
    ]);
    await setup.adapter.createRooms([
      {
        id: roomId,
        agentId: setup.testAgentId,
        source: "test",
        type: ChannelType.DM,
      },
    ]);
  });
  afterAll(async () => {
    await setup?.cleanup();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("sends the complete approved prompt and persists metadata-only intent and response", async () => {
    const f = fixture();
    const prompt = `SYNTHETIC_SENSITIVE_VALUE ${"complete content ".repeat(1000)}`;
    await expect(f.runtime.useModel(ModelType.TEXT_LARGE, { prompt })).resolves.toBe(
      "complete reply"
    );
    expect(requests.at(-1)?.body).toContain(prompt);
    expect(f.records.map((r) => r.phase)).toEqual(["dispatch_intent", "response_headers"]);
    const logs = await setup.adapter.getLogs({
      entityId,
      roomId,
      type: "processor_dispatch",
      count: 100,
    });
    expect(logs.some((log) => log.body.attemptId === f.records[0].attemptId)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("SYNTHETIC_SENSITIVE_VALUE");
    expect(JSON.stringify(logs)).not.toContain("test-credential");
  });

  it.each(["handler", "endpoint", "model", "audit"])(
    "blocks %s rejection before network transmission",
    async (kind) => {
      const f = fixture({
        untrusted: kind === "handler",
        auditFailure: kind === "audit",
        route: kind === "endpoint" ? `${endpoint}/not-approved` : undefined,
      });
      const count = requests.length;
      await expect(
        f.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "sensitive synthetic input",
          ...(kind === "model" ? { model: "unapproved-model" } : {}),
        })
      ).rejects.toMatchObject({
        code: expect.stringContaining("CONFIDENTIAL_INFERENCE_"),
      });
      expect(requests).toHaveLength(count);
    }
  );

  it("reevaluates a revoked profile on the next actual request", async () => {
    const f = fixture();
    await f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "first" });
    f.revoke();
    const count = requests.length;
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "second" })
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_ROUTE_DENIED" });
    expect(requests).toHaveLength(count);
  });
  it("rechecks a policy revoked after the first HTTP attempt before an SDK retry", async () => {
    const f = fixture();
    const count = requests.length;
    responseStatuses = [429];
    onRequest = () => {
      f.revoke();
      onRequest = undefined;
    };
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "retry-sensitive", retries: 1 })
    ).rejects.toBeDefined();
    expect(requests).toHaveLength(count + 1);
  });

  it("rejects an internal provider fallback before its alternate endpoint receives a body", async () => {
    const f = fixture({ modelHandler: handleTextLarge });
    f.runtime.setSetting("ELIZA_PROVIDER", "cerebras");
    f.runtime.setSetting("CEREBRAS_API_KEY", "primary-fixture-key");
    f.runtime.setSetting("CEREBRAS_LARGE_MODEL", "approved-model");
    f.runtime.setSetting("OPENROUTER_FALLBACK_MODEL", "approved-model");
    f.runtime.setSetting("OPENROUTER_BASE_URL", `${endpoint}/fallback`);
    f.runtime.setSetting("OPENROUTER_API_KEY", "fallback-fixture-key");
    f.runtime.setSetting("ELIZA_TRAJECTORY_STRICT", "0");
    f.runtime.setSetting("ELIZA_TRAJECTORY_LOGGING", "0");
    const count = requests.length;
    responseStatuses = [429];
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "fallback-sensitive" })
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_ROUTE_DENIED" });
    expect(requests).toHaveLength(count + 1);
    expect(requests.at(-1)?.url).toBe("/v1/chat/completions");
  });
  it("keeps concurrent runtime policies isolated", async () => {
    const approved = fixture();
    const denied = fixture({ route: `${endpoint}/different-route` });
    const count = requests.length;
    const results = await Promise.allSettled([
      approved.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "approved concurrent" }),
      denied.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "denied concurrent" }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(requests).toHaveLength(count + 1);
    expect(requests.at(-1)?.body).not.toContain("denied concurrent");
  });

  it("preserves ordinary dispatch when the host selects no confidential authority", async () => {
    const runtime = new AgentRuntime({
      agentId: setup.testAgentId,
      adapter: setup.adapter,
      settings: { OPENAI_API_KEY: "normal-test-key", OPENAI_BASE_URL: endpoint },
      logLevel: "fatal",
    });
    runtime.registerModel(ModelType.TEXT_LARGE, handler, "ordinary-provider", 100);
    await expect(
      runtime.useModel(ModelType.TEXT_LARGE, { prompt: "normal mode", model: "ordinary-model" })
    ).resolves.toBe("complete reply");
    expect(requests.at(-1)?.body).toContain("ordinary-model");
  });
  it("cancels an unaudited response and does not repeat the already dispatched request", async () => {
    const f = fixture({ outcomeAuditFailure: true });
    const count = requests.length;
    const closed = new Promise<void>((resolve) => {
      onResponseClosed = resolve;
    });
    holdResponse = true;
    try {
      await expect(
        f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "outcome-sensitive", retries: 2 })
      ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_OUTCOME_UNRECORDED" });
      await closed;
      expect(requests).toHaveLength(count + 1);
      expect(f.records.map((record) => record.phase)).toEqual(["dispatch_intent"]);
    } finally {
      holdResponse = false;
      onResponseClosed = undefined;
    }
  });
  it("links a revocation during audit to the same undispatched attempt", async () => {
    const f = fixture({
      afterAudit: (record) => {
        if (record.phase === "dispatch_intent") f.revoke();
      },
    });
    const count = requests.length;
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "audit-revocation-sensitive" })
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_POLICY_CHANGED" });
    expect(requests).toHaveLength(count);
    expect(f.records.map((record) => record.phase)).toEqual(["dispatch_intent", "denied"]);
    expect(f.records[0].attemptId).toBe(f.records[1].attemptId);
    expect(JSON.stringify(f.records)).not.toContain("audit-revocation-sensitive");
  });
  it("commits verified transport digests before actual HTTP bytes", async () => {
    const evidence = { evidenceDigest: "a".repeat(64), connectionBindingDigest: "b".repeat(64) };
    const count = requests.length;
    const f = fixture({
      transport: async (url, init, context) => {
        expect(f.records).toHaveLength(0);
        expect(context.route.endpoint).toBe(url);
        await context.beforeDispatch(evidence);
        expect(requests).toHaveLength(count);
        expect(f.records[0]).toMatchObject({
          phase: "dispatch_intent",
          evidenceDigest: evidence.evidenceDigest,
          connectionBindingDigest: evidence.connectionBindingDigest,
        });
        return fetch(url, init);
      },
    });
    await expect(f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "proof-bound" })).resolves.toBe(
      "complete reply"
    );
    expect(f.records[1]).toMatchObject({
      phase: "response_headers",
      evidenceDigest: evidence.evidenceDigest,
      connectionBindingDigest: evidence.connectionBindingDigest,
    });
    expect(JSON.stringify(f.records)).not.toContain(evidence.rawPayload);
  });
  it("rejects a transport that omits its authenticated pre-send callback", async () => {
    const count = requests.length;
    const f = fixture({ transport: async () => new Response("untrusted transport reply") });
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "must not send" })
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_TRANSPORT_CONTRACT" });
    expect(requests).toHaveLength(count);
  });
  it("rejects invalid transport evidence before sending a request", async () => {
    const count = requests.length;
    const f = fixture({
      transport: async (url, init, context) => {
        await context.beforeDispatch({
          evidenceDigest: "invalid",
          connectionBindingDigest: "b".repeat(64),
        });
        return fetch(url, init);
      },
    });
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "must not send" })
    ).rejects.toMatchObject({ code: "CONFIDENTIAL_INFERENCE_TRANSPORT_CONTRACT" });
    expect(requests).toHaveLength(count);
    expect(f.records[0].phase).toBe("denied");
  });
  it("requires reconciliation before an SDK redispatch after authorization", async () => {
    const count = requests.length;
    const f = fixture({ redispatchPolicy: "deny-after-authorization" });
    responseStatuses = [429];
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "only once", retries: 2 })
    ).rejects.toBeDefined();
    expect(requests).toHaveLength(count + 1);
    expect(f.records.at(-1)).toMatchObject({
      phase: "denied",
      denialCode: "CONFIDENTIAL_INFERENCE_REDISPATCH_REQUIRES_RECONCILIATION",
    });
  });
  it("carries the no-redispatch authority across actual runtime provider failover", async () => {
    let backupCalls = 0;
    const backup: typeof handler = async (runtime, params) => {
      backupCalls++;
      return handler(runtime, params);
    };
    const f = fixture({
      redispatchPolicy: "deny-after-authorization",
      additionalHandlers: [backup],
    });
    f.runtime.registerModel(ModelType.TEXT_LARGE, backup, "trusted-backup", 10);
    const count = requests.length;
    responseStatuses = [429];
    await expect(
      f.runtime.useModel(ModelType.TEXT_LARGE, { prompt: "no hidden repeat" })
    ).rejects.toBeDefined();
    expect(backupCalls).toBe(1);
    expect(requests).toHaveLength(count + 1);
    expect(f.records.at(-1)).toMatchObject({
      phase: "denied",
      denialCode: "CONFIDENTIAL_INFERENCE_REDISPATCH_REQUIRES_RECONCILIATION",
    });
  });
});
