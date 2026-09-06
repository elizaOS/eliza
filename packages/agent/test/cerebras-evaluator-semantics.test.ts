/**
 * Exercises semantic-evidence readbacks against migrated PGlite and the real
 * OpenAI-compatible SDK. Deterministic loopback completions drive the actual
 * four builtin processors; no evaluator, identity service or database is mocked.
 */
import { createServer } from "node:http";
import { ModelType } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { afterEach, expect, it, vi } from "vitest";
import { handleTextSmall } from "../../../plugins/plugin-openai/models/index.ts";
import {
  assertNoSemanticEffects,
  assertSemanticEffects,
  createSemanticFixtures,
  prepareSemanticEvaluators,
  type ReplayFinish,
  replayResponseBody,
  runSemanticFixture,
} from "../scripts/cerebras-evaluator-semantics.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("persists both owned semantic fixtures and rejects incomplete replay without effects", async () => {
  const fixtures = createSemanticFixtures();
  let finish: ReplayFinish = "original";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push(body);
      const fixture = fixtures.find((entry) => body.includes(entry.handle));
      if (!fixture) {
        response.writeHead(400);
        response.end("Fixture context missing");
        return;
      }
      const payload = {
        factMemory: {
          ops: [
            {
              op: "add_durable",
              category: "identity",
              claim: `${fixture.name} lives in ${fixture.town}.`,
              structured_fields: { location: fixture.town },
              keywords: [fixture.name, fixture.town],
            },
          ],
        },
        relationships: {
          relationships: fixture.colleagueId
            ? [
                {
                  sourceEntityId: fixture.entityId,
                  targetEntityId: fixture.colleagueId,
                  tags: ["colleague"],
                  metadata: { relationshipType: "colleague" },
                },
              ]
            : [],
        },
        identities: {
          identities: [
            {
              entityId: fixture.entityId,
              platform: "github",
              handle: fixture.handle,
              confidence: 0.99,
            },
          ],
        },
        success: {
          completed: fixture.completed,
          reason: fixture.completed
            ? "The requested acknowledgement is present."
            : "The destination is missing and no booking exists.",
        },
      };
      const original = JSON.stringify({
        id: "semantic-loopback",
        object: "chat.completion",
        created: 0,
        model: "qwen-3.8-27b",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify(payload) },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 4000,
          completion_tokens: 300,
          total_tokens: 4300,
        },
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(replayResponseBody(original, finish));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing loopback port");
  vi.stubEnv("CEREBRAS_API_KEY", "loopback-test-only");
  vi.stubEnv("CEREBRAS_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
  vi.stubEnv("CEREBRAS_SMALL_MODEL", "qwen-3.8-27b");
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_BASE_URL", undefined);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== `http://127.0.0.1:${address.port}`)
      throw new Error("Semantic test forbids remote calls");
    return originalFetch(input, init);
  }) as typeof fetch;
  let live: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  try {
    live = await createTestRuntime({
      characterName: "SemanticBuiltinTest",
      embeddingDimensions: 384,
    });
    live.runtime.registerModel(
      ModelType.TEXT_SMALL,
      handleTextSmall,
      "openai",
      100,
    );
    const relationships = await prepareSemanticEvaluators(live.runtime);
    const agentId = live.runtime.agentId;
    for (const fixture of fixtures) {
      const run = await runSemanticFixture(
        live.runtime,
        relationships,
        fixture,
      );
      expect(run.result.errors).toEqual([]);
      assertSemanticEffects(fixture, run.after, live.runtime.agentId);
      // A superficially successful processor result must not hide a missing DB identity.
      expect(() =>
        assertSemanticEffects(
          fixture,
          { ...run.after, identities: [] },
          agentId,
        ),
      ).toThrow("persisted owned GitHub identity");
      if (!fixture.completed)
        expect(JSON.stringify(requests.at(-1))).toContain(
          "Destination is missing",
        );
    }
    await live.cleanup();
    live = undefined;
    for (const rejected of ["length", "content_filter", "malformed"] as const) {
      finish = rejected;
      live = await createTestRuntime({
        characterName: "SemanticBuiltinTest",
        embeddingDimensions: 384,
      });
      live.runtime.registerModel(
        ModelType.TEXT_SMALL,
        handleTextSmall,
        "openai",
        100,
      );
      const service = await prepareSemanticEvaluators(live.runtime);
      const fixture = fixtures[0];
      if (!fixture) throw new Error("Missing fixture");
      const run = await runSemanticFixture(live.runtime, service, fixture);
      expect(run.result.errors.length).toBeGreaterThan(0);
      assertNoSemanticEffects(run.after);
      await live.cleanup();
      live = undefined;
    }
  } finally {
    await live?.cleanup();
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 180_000);
