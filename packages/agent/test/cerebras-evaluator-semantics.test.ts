/**
 * Exercises semantic-evidence readbacks against migrated PGlite and the real
 * OpenAI-compatible SDK. Deterministic loopback completions drive the actual
 * four builtin processors; no evaluator, identity service or database is mocked.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MemoryType, ModelType, type UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { afterEach, expect, it, vi } from "vitest";
import { handleTextSmall } from "../../../plugins/plugin-openai/models/index.ts";
import {
  assertNoSemanticEffects,
  assertSemanticEffects,
  createSemanticFixtures,
  prepareSemanticEvaluators,
  type ReplayFinish,
  readRetainedSemanticEvidence,
  readSemanticEffects,
  replayResponseBody,
  runSemanticFixture,
} from "../scripts/cerebras-evaluator-semantics.ts";
import { shutdownRuntime } from "../src/runtime/eliza.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("persists both owned semantic fixtures and rejects incomplete replay without effects", async () => {
  const fixtures = createSemanticFixtures();
  let finish: ReplayFinish = "original";
  let conflictingRelationship = false;
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
      const requestBody = JSON.parse(body) as {
        messages: Array<{ role: string; content: string }>;
        response_format?: { type?: string; json_schema?: { schema?: unknown } };
      };
      const prompt = requestBody.messages.find(
        (message) => message.role === "user",
      )?.content;
      // Every request carries the complete prompt contract; constrained requests
      // additionally carry the same contract in the provider schema.
      const structural = requestBody.response_format?.type === "json_schema";
      const schemaMatch =
        prompt &&
        /## Output JSON Schema\n([\s\S]*?)\n\nEvaluate just-finished turn/.exec(
          prompt,
        );
      const contract = (
        structural
          ? requestBody.response_format?.json_schema?.schema
          : schemaMatch?.[1]
            ? JSON.parse(schemaMatch[1])
            : undefined
      ) as
        | {
            required: string[];
            properties: {
              identities: {
                properties: { identities: { items: { required: string[] } } };
              };
            };
          }
        | undefined;
      // The complete contract is visible in the prompt on every rung; the
      // structural request also carries it on the wire.
      if (!contract || !schemaMatch) {
        response.writeHead(400);
        response.end("Complete output contract missing");
        return;
      }
      const handleField =
        contract.properties.identities.properties.identities.items.required.find(
          (field: string) => field === "handle",
        );
      if (
        !handleField ||
        !["factMemory", "relationships", "identities", "success"].every(
          (name) => contract.required.includes(name),
        )
      ) {
        response.writeHead(400);
        response.end("Builtin output contract incomplete");
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
                  relationshipType: "colleague",
                  ...(conflictingRelationship
                    ? { metadata: { relationshipType: "parent" } }
                    : {}),
                },
              ]
            : [],
        },
        identities: {
          identities: [
            {
              entityId: fixture.entityId,
              platform: "github",
              [handleField]: fixture.handle,
              sourceMessageId: fixture.messageId,
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
  const retainedRoot = await mkdtemp(join(tmpdir(), "semantic-restart-"));
  const retainedDatabase = join(retainedRoot, "database");
  let live: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  try {
    live = await createTestRuntime({
      characterName: "SemanticBuiltinTest",
      embeddingDimensions: 384,
      pgliteDir: retainedDatabase,
      removePgliteDirOnCleanup: false,
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
      assertSemanticEffects(fixture, run.after, live.runtime.agentId, fixtures);
      // A superficially successful processor result must not hide a missing DB identity.
      expect(() =>
        assertSemanticEffects(
          fixture,
          { ...run.after, identities: [] },
          agentId,
          fixtures,
        ),
      ).toThrow("persisted owned GitHub identity");
      if (!fixture.completed)
        expect(JSON.stringify(requests.at(-1))).toContain(
          "Destination is missing",
        );
    }
    const retainedReport = join(retainedRoot, "parent.json");
    const resumedReport = join(retainedRoot, "resumed.json");
    const runtimeBeforeRestart = live.runtime;
    const serviceBeforeRestart =
      await prepareSemanticEvaluators(runtimeBeforeRestart);
    await writeFile(
      retainedReport,
      JSON.stringify({
        status: "success",
        processId: process.pid,
        agentId: live.runtime.agentId,
        characterName: "SemanticBuiltinTest",
        databaseDirectory: retainedDatabase,
        retainedDatabase: true,
        fixtures,
        finalReadbacks: await Promise.all(
          fixtures.map(async (fixture) => ({
            fixtureId: fixture.id,
            effects: await readSemanticEffects(
              runtimeBeforeRestart,
              serviceBeforeRestart,
              fixture,
            ),
          })),
        ),
      }),
      { mode: 0o600 },
    );
    await expect(readRetainedSemanticEvidence(retainedReport)).rejects.toThrow(
      "distinct process",
    );
    await shutdownRuntime(live.runtime, "semantic test restart boundary");
    await live.cleanup();
    live = undefined;
    const moduleUrl = new URL(
      "../scripts/cerebras-evaluator-semantics.ts",
      import.meta.url,
    ).href;
    const runReadbackChild = () =>
      promisify(execFile)(
        "bun",
        [
          "--conditions=eliza-source",
          "--eval",
          `
      import { readRetainedSemanticEvidence } from ${JSON.stringify(moduleUrl)};
      import { writeFile } from "node:fs/promises";
      const receipt = await readRetainedSemanticEvidence(${JSON.stringify(retainedReport)});
      await writeFile(${JSON.stringify(resumedReport)}, JSON.stringify(receipt));
    `,
        ],
        { timeout: 120000, maxBuffer: 16 * 1024 * 1024 },
      );
    await runReadbackChild();
    const resumed = JSON.parse(await readFile(resumedReport, "utf8"));
    expect(resumed.processId).not.toBe(process.pid);
    expect(resumed.agentId).toBe(agentId);
    expect(
      resumed.readbacks.map((entry: { fixtureId: string }) => entry.fixtureId),
    ).toEqual(fixtures.map((entry) => entry.id));
    live = await createTestRuntime({
      characterName: "SemanticBuiltinTest",
      embeddingDimensions: 384,
      pgliteDir: retainedDatabase,
      removePgliteDirOnCleanup: false,
    });
    live.runtime.registerModel(
      ModelType.TEXT_SMALL,
      handleTextSmall,
      "openai",
      100,
    );
    const resumedRelationships = await prepareSemanticEvaluators(live.runtime);
    const [fixture, foreign] = fixtures;
    if (!fixture || !foreign) throw new Error("Missing adversarial fixtures");
    const runtime = live.runtime;
    const assertCurrent = async () => {
      const effects = await readSemanticEffects(
        runtime,
        resumedRelationships,
        fixture,
      );
      assertSemanticEffects(fixture, effects, agentId, fixtures);
    };
    // Real additional owned data is allowed; acceptance is not an exact row-count snapshot.
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        agentId: runtime.agentId,
        entityId: fixture.entityId as UUID,
        roomId: fixture.roomId as UUID,
        content: { text: "Mira enjoys pottery." },
        metadata: {
          type: MemoryType.CUSTOM,
          source: "fact_extractor",
          kind: "durable",
        },
      },
      "facts",
    );
    await assertCurrent();
    const badFactId = randomUUID() as UUID;
    await runtime.createMemory(
      {
        id: badFactId,
        agentId: runtime.agentId,
        entityId: fixture.entityId as UUID,
        roomId: fixture.roomId as UUID,
        content: { text: `Mira lives in ${foreign.town}.` },
        metadata: {
          type: MemoryType.CUSTOM,
          source: "fact_extractor",
          kind: "durable",
        },
      },
      "facts",
    );
    await expect(assertCurrent()).rejects.toThrow("contaminated fact");
    await runtime.deleteMemory(badFactId);
    const contradictoryId = randomUUID() as UUID;
    await runtime.createMemory(
      {
        id: contradictoryId,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: fixture.roomId as UUID,
        content: {
          type: "task_completion_reflection",
          text: "Contradictory assessment",
        },
        metadata: {
          type: MemoryType.CUSTOM,
          messageId: fixture.messageId,
          taskAssessed: true,
          taskCompleted: false,
          taskCompletionReason: "Not done",
        },
      },
      "memories",
    );
    await expect(assertCurrent()).rejects.toThrow(
      "contradictory same-message completion",
    );
    await runtime.deleteMemory(contradictoryId);
    await assertCurrent();
    await resumedRelationships.upsertIdentity(
      fixture.entityId as UUID,
      {
        platform: "github",
        handle: foreign.handle,
        confidence: 0.8,
        verified: false,
        source: "reflection",
      },
      [fixture.messageId as UUID],
    );
    await expect(assertCurrent()).rejects.toThrow("contaminated identity");
    await shutdownRuntime(live.runtime, "corrupt retained semantic evidence");
    await live.cleanup();
    live = undefined;
    await expect(runReadbackChild()).rejects.toThrow("contaminated identity");
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
    finish = "original";
    conflictingRelationship = true;
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
    const conflictService = await prepareSemanticEvaluators(live.runtime);
    const conflictFixture = fixtures[0];
    if (!conflictFixture) throw new Error("Missing conflict fixture");
    const conflictRun = await runSemanticFixture(
      live.runtime,
      conflictService,
      conflictFixture,
    );
    expect(conflictRun.result.errors).toEqual([
      {
        evaluatorName: "relationships",
        error: "Evaluator output section did not validate",
      },
    ]);
    expect(conflictRun.result.processedEvaluators).not.toContain(
      "relationships",
    );
    expect(conflictRun.after.relationships).toEqual([]);
    // Other valid sections still run; the rejection belongs to the relationship section.
    expect(
      conflictRun.after.identities.some(
        (identity) => identity.handle === conflictFixture.handle,
      ),
    ).toBe(true);
    expect(conflictRun.after.completion?.completed).toBe(true);
    expect(
      conflictRun.after.facts.some((fact) =>
        fact.content.text?.includes(conflictFixture.town),
      ),
    ).toBe(true);
  } finally {
    await live?.cleanup();
    globalThis.fetch = originalFetch;
    await rm(retainedRoot, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 180_000);
