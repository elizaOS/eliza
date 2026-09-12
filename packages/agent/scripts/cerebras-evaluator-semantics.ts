#!/usr/bin/env bun
/**
 * Verifies builtin evaluator effects through real provider transport and isolated
 * PGlite storage. Controlled conversation fixtures are not generated chat or UI
 * evidence. Full wire responses support separately labelled replay controls;
 * no external identity API is invoked and failed runs retain partial readbacks.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  MemoryType,
  ModelType,
  type State,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { z } from "zod";
import { reflectionItems } from "../../core/src/features/advanced-capabilities/evaluators/reflection-items.ts";
import {
  getTaskCompletionCacheKey,
  type TaskCompletionAssessment,
} from "../../core/src/features/advanced-capabilities/evaluators/task-completion.ts";
import { EvaluatorService } from "../../core/src/services/evaluator.ts";
import { RelationshipsService } from "../../core/src/services/relationships.ts";
import { shutdownRuntime } from "../src/runtime/eliza.ts";
import {
  measuredProviderFetch,
  type ProviderWireEvidence,
} from "./cerebras-chat-flow-experiment.ts";
import {
  captureModelInput,
  configuredModelEnvironment,
  jsonEvidence,
  type ModelInputEvidence,
  sourceRevisionEvidence,
} from "./cerebras-chat-flow-latency.ts";

export const semanticFixtureSchema = z.object({
  id: z.enum(["acknowledged", "pending"]),
  worldId: z.string().uuid(),
  roomId: z.string().uuid(),
  entityId: z.string().uuid(),
  colleagueId: z.string().uuid().nullable(),
  messageId: z.string().uuid(),
  responseId: z.string().uuid(),
  name: z.string().min(1),
  town: z.string().min(1),
  handle: z.string().min(1),
  userText: z.string().min(1),
  assistantText: z.string().min(1),
  completed: z.boolean(),
});
export type SemanticFixture = z.infer<typeof semanticFixtureSchema>;

export function createSemanticFixtures(): SemanticFixture[] {
  const runId = randomUUID();
  return [true, false].map((completed) => {
    const name = completed ? "Mira" : "Iris";
    const town = completed ? "Larkspur Hollow" : "Cobalt Orchard";
    const handle = `guardian-${name.toLowerCase()}-${runId}`;
    return {
      id: completed ? "acknowledged" : "pending",
      worldId: randomUUID(),
      roomId: randomUUID(),
      entityId: randomUUID(),
      colleagueId: completed ? randomUUID() : null,
      messageId: randomUUID(),
      responseId: randomUUID(),
      name,
      town,
      handle,
      completed,
      userText: completed
        ? `I am Mira. I live permanently in ${town}. Theo, who is here in this room, is my colleague at Lantern Workshop. My own GitHub username is ${handle}. Please just acknowledge these details.`
        : `I am Iris. I live permanently in ${town}. My own GitHub username is ${handle}. Please book a train ticket for me, but I have not told you my destination yet.`,
      assistantText: completed
        ? `Acknowledged, Mira. You live in ${town}, Theo is your colleague at Lantern Workshop, and your GitHub username is ${handle}.`
        : "I cannot book your ticket yet. What destination should I use? No ticket has been booked.",
    };
  });
}

/** Registers real processors and requires their actual SQL identity collaborator. */
export async function prepareSemanticEvaluators(
  runtime: AgentRuntime,
): Promise<RelationshipsService> {
  for (const evaluator of [...runtime.evaluators])
    runtime.unregisterEvaluator(evaluator.name);
  for (const evaluator of reflectionItems) runtime.registerEvaluator(evaluator);
  if (!runtime.hasService("relationships"))
    await runtime.registerService(RelationshipsService);
  const service = await runtime.getServiceLoadPromise("relationships");
  if (!(service instanceof RelationshipsService))
    throw new Error(
      "Semantic proof requires the production RelationshipsService",
    );
  if (
    runtime.evaluators.length !== 4 ||
    !reflectionItems.every((item) => runtime.evaluators.includes(item))
  )
    throw new Error(
      "All four production builtin evaluators must be registered",
    );
  return service;
}

/** Persists complete controlled messages before builtin prepare reads the room. */
export async function persistSemanticFixture(
  runtime: AgentRuntime,
  fixture: SemanticFixture,
) {
  await runtime.ensureWorldExists({
    id: fixture.worldId as UUID,
    agentId: runtime.agentId,
    name: `Evaluator ${fixture.id}`,
  });
  for (const [id, name] of [
    [fixture.entityId, fixture.name],
    ...(fixture.colleagueId ? [[fixture.colleagueId, "Theo"]] : []),
  ]) {
    if (!id || !name) throw new Error("Incomplete semantic participant");
    await runtime.ensureConnection({
      entityId: id as UUID,
      roomId: fixture.roomId as UUID,
      worldId: fixture.worldId as UUID,
      worldName: `Evaluator ${fixture.id}`,
      userName: name,
      name,
      source: "client_chat",
      channelId: fixture.roomId,
      type: ChannelType.GROUP,
    });
  }
  await runtime.ensureParticipantInRoom(
    runtime.agentId,
    fixture.roomId as UUID,
  );
  const message = createMessageMemory({
    id: fixture.messageId as UUID,
    agentId: runtime.agentId,
    entityId: fixture.entityId as UUID,
    roomId: fixture.roomId as UUID,
    content: {
      text: fixture.userText,
      source: "client_chat",
      channelType: ChannelType.GROUP,
    },
  });
  const response = createMessageMemory({
    id: fixture.responseId as UUID,
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: fixture.roomId as UUID,
    content: {
      text: fixture.assistantText,
      source: "client_chat",
      inReplyTo: fixture.messageId as UUID,
    },
  });
  await runtime.createMemory(message, "messages");
  await runtime.createMemory(response, "messages");
  const state: State = {
    text: fixture.userText,
    values: {},
    data: {
      actionResults: fixture.completed
        ? []
        : [
            {
              success: false,
              text: "Destination is missing; no booking was attempted.",
              error: "DESTINATION_REQUIRED",
              data: {
                fixture: true,
                awaitingInput: true,
                destination: null,
                bookingCreated: false,
              },
            },
          ],
    },
  };
  return { message, response, state };
}

export async function readSemanticEffects(
  runtime: AgentRuntime,
  relationships: RelationshipsService,
  fixture: SemanticFixture,
) {
  const [facts, memories, identities, relations, completion] =
    await Promise.all([
      runtime.getMemories({
        tableName: "facts",
        roomId: fixture.roomId as UUID,
        unique: false,
      }),
      runtime.getMemories({
        tableName: "memories",
        roomId: fixture.roomId as UUID,
        unique: false,
      }),
      Promise.all(
        [
          fixture.entityId,
          ...(fixture.colleagueId ? [fixture.colleagueId] : []),
        ].map((id) => relationships.getEntityIdentities(id as UUID)),
      ).then((rows) => rows.flat()),
      runtime.getRelationships({ entityIds: [fixture.entityId as UUID] }),
      runtime.getCache<TaskCompletionAssessment>(
        getTaskCompletionCacheKey(fixture.messageId as UUID),
      ),
    ]);
  return {
    facts,
    reflections: memories.filter(
      (memory) => memory.content.type === "task_completion_reflection",
    ),
    identities,
    relationships: relations,
    completion: completion ?? null,
  };
}
export type SemanticEffects = Awaited<ReturnType<typeof readSemanticEffects>>;

/** Checks real domain effects; processor success counts alone cannot satisfy acceptance. */
export function assertSemanticEffects(
  fixture: SemanticFixture,
  effects: SemanticEffects,
  agentId: string,
  fixtures: readonly SemanticFixture[],
): void {
  const foreignFixtures = fixtures.filter(
    (candidate) => candidate.id !== fixture.id,
  );
  const foreignMarkers = foreignFixtures.flatMap((candidate) => [
    candidate.town,
    candidate.handle,
    candidate.entityId,
    candidate.messageId,
  ]);
  const containsForeignFixture = (value: unknown) => {
    const serialized = JSON.stringify(value).toLowerCase();
    return foreignMarkers.some((marker) =>
      serialized.includes(marker.toLowerCase()),
    );
  };
  for (const fact of effects.facts) {
    if (
      fact.entityId !== fixture.entityId ||
      fact.roomId !== fixture.roomId ||
      fact.agentId !== agentId ||
      containsForeignFixture(fact)
    )
      throw new Error(
        `${fixture.id}: contaminated fact ownership or foreign fixture content`,
      );
  }
  for (const identity of effects.identities) {
    if (
      identity.entityId !== fixture.entityId ||
      containsForeignFixture(identity)
    )
      throw new Error(
        `${fixture.id}: contaminated identity ownership or foreign fixture content`,
      );
  }
  for (const reflection of effects.reflections) {
    const metadata = reflection.metadata;
    if (
      reflection.agentId !== agentId ||
      reflection.entityId !== agentId ||
      reflection.roomId !== fixture.roomId ||
      containsForeignFixture(reflection)
    )
      throw new Error(
        `${fixture.id}: contaminated completion ownership or foreign fixture content`,
      );
    if (
      metadata?.type === MemoryType.CUSTOM &&
      metadata.messageId === fixture.messageId &&
      (metadata.taskAssessed !== true ||
        metadata.taskCompleted !== fixture.completed ||
        typeof metadata.taskCompletionReason !== "string" ||
        !metadata.taskCompletionReason.trim())
    )
      throw new Error(
        `${fixture.id}: contradictory same-message completion row`,
      );
  }
  if (
    effects.relationships.some(containsForeignFixture) ||
    (effects.completion && containsForeignFixture(effects.completion))
  )
    throw new Error(
      `${fixture.id}: foreign fixture content in relationship or completion`,
    );
  const ownedFacts = effects.facts.filter(
    (fact) =>
      fact.entityId === fixture.entityId &&
      fact.roomId === fixture.roomId &&
      fact.agentId === agentId &&
      fact.metadata?.type === MemoryType.CUSTOM &&
      fact.metadata.source === "fact_extractor" &&
      fact.metadata.kind === "durable",
  );
  if (
    !ownedFacts.some((fact) =>
      JSON.stringify({
        text: fact.content.text,
        fields:
          fact.metadata?.type === MemoryType.CUSTOM
            ? fact.metadata.structuredFields
            : null,
      })
        .toLowerCase()
        .includes(fixture.town.toLowerCase()),
    )
  )
    throw new Error(
      `${fixture.id}: missing durable location fact with correct ownership`,
    );
  const identity = effects.identities.find(
    (item) =>
      item.entityId === fixture.entityId &&
      item.platform === "github" &&
      item.handle === fixture.handle &&
      item.source === "reflection" &&
      item.verified === false &&
      item.evidenceMessageIds.includes(fixture.messageId as UUID),
  );
  if (!identity)
    throw new Error(
      `${fixture.id}: missing persisted owned GitHub identity with message evidence`,
    );
  if (
    fixture.colleagueId &&
    !effects.relationships.some(
      (item) =>
        item.sourceEntityId === fixture.entityId &&
        item.targetEntityId === fixture.colleagueId &&
        /colleague|coworker|co-worker|business|work/i.test(
          JSON.stringify({ tags: item.tags, metadata: item.metadata }),
        ),
    )
  )
    throw new Error(`${fixture.id}: missing supported colleague relationship`);
  const permitted = new Set([fixture.entityId, fixture.colleagueId, agentId]);
  if (
    effects.relationships.some(
      (item) =>
        !permitted.has(item.sourceEntityId) ||
        !permitted.has(item.targetEntityId),
    )
  )
    throw new Error(
      `${fixture.id}: relationship escaped its known room participants`,
    );
  if (
    !effects.reflections.some(
      (memory) =>
        memory.agentId === agentId &&
        memory.roomId === fixture.roomId &&
        memory.metadata?.type === MemoryType.CUSTOM &&
        memory.metadata.messageId === fixture.messageId &&
        memory.metadata.taskAssessed === true &&
        memory.metadata.taskCompleted === fixture.completed &&
        typeof memory.metadata.taskCompletionReason === "string" &&
        memory.metadata.taskCompletionReason.trim(),
    )
  )
    throw new Error(
      `${fixture.id}: missing correctly linked task completion memory`,
    );
  if (
    !effects.completion?.assessed ||
    effects.completion.completed !== fixture.completed ||
    effects.completion.messageId !== fixture.messageId ||
    !effects.completion.reason.trim()
  )
    throw new Error(
      `${fixture.id}: task completion cache disagrees with fixture`,
    );
}

export function assertNoSemanticEffects(effects: SemanticEffects): void {
  if (
    effects.facts.length ||
    effects.reflections.length ||
    effects.identities.length ||
    effects.relationships.length ||
    effects.completion !== null
  )
    throw new Error("Rejected evaluator output produced domain effects");
}

export async function runSemanticFixture(
  runtime: AgentRuntime,
  service: RelationshipsService,
  fixture: SemanticFixture,
) {
  const messages = await persistSemanticFixture(runtime, fixture);
  const before = await readSemanticEffects(runtime, service, fixture);
  assertNoSemanticEffects(before);
  const result = await new EvaluatorService(runtime).run(
    messages.message,
    messages.state,
    { didRespond: true, responses: [messages.response], semanticSignal: true },
  );
  const after = await readSemanticEffects(runtime, service, fixture);
  return { fixture, messages, before, result, after };
}

const replaySchema = z.object({
  status: z.literal("success"),
  sourceRevision: z.object({
    head: z.string().regex(/^[a-f0-9]{40}$/),
    treeClean: z.literal(true),
  }),
  fixtures: z.array(semanticFixtureSchema).length(2),
  wireResponses: z.array(
    z.object({
      fixtureId: z.string().nullable(),
      status: z.number(),
      body: z.string(),
    }),
  ),
});
export type ReplayFinish =
  | "original"
  | "length"
  | "content_filter"
  | "malformed";
export function replayResponseBody(body: string, finish: ReplayFinish): string {
  if (finish === "original") return body;
  const parsed = z
    .object({
      choices: z
        .array(
          z
            .object({
              finish_reason: z.string().nullable(),
              message: z
                .object({ content: z.string().nullable() })
                .passthrough(),
            })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough()
    .parse(JSON.parse(body));
  for (const choice of parsed.choices) {
    if (finish === "malformed") choice.message.content = "{malformed";
    else choice.finish_reason = finish;
  }
  return JSON.stringify(parsed);
}

async function main() {
  const argumentsByName = new Map(
    process.argv.slice(2).map((argument) => {
      const split = argument.indexOf("=");
      if (split < 0)
        throw new Error(
          "Use --output=PATH --pglite-dir=NEW_PATH [--replay=REPORT --finish=original|length|content_filter|malformed]",
        );
      return [
        argument.substring(0, split),
        argument.substring(split + 1),
      ] as const;
    }),
  );
  const output = argumentsByName.get("--output");
  const directory = argumentsByName.get("--pglite-dir");
  if (!output || !directory)
    throw new Error("Explicit --output and a new --pglite-dir are required");
  const replayPath = argumentsByName.get("--replay");
  const finish = z
    .enum(["original", "length", "content_filter", "malformed"])
    .parse(argumentsByName.get("--finish") ?? "original");
  if (!replayPath && finish !== "original")
    throw new Error("Finish controls are loopback replay only");
  const sourceRevision = sourceRevisionEvidence(
    fileURLToPath(new URL("../../..", import.meta.url)),
    [
      "packages/agent/scripts",
      "packages/agent/src",
      "packages/core/src",
      "packages/logger/src",
      "packages/prompts/src",
      "packages/shared/src",
      "packages/vault/src",
      "packages/registry/src",
      "packages/cloud/routing/src",
      "plugins/plugin-openai",
      "plugins/plugin-sql/src",
      "plugins/plugin-local-inference/src",
    ],
  );
  const model = process.env.ELIZA_CEREBRAS_CHAT_MODEL;
  if (model !== "qwen-3.8-27b")
    throw new Error("Independently verified qwen-3.8-27b is required");
  if (!replayPath && !process.env.CEREBRAS_API_KEY?.trim())
    throw new Error("CEREBRAS_API_KEY is required through normal env loading");
  const replayBytes = replayPath ? await readFile(replayPath) : null;
  const replay = replayBytes
    ? replaySchema.parse(JSON.parse(replayBytes.toString("utf8")))
    : null;
  const fixtures = replay?.fixtures ?? createSemanticFixtures();
  if (
    new Set(fixtures.map((fixture) => fixture.id)).size !== 2 ||
    new Set(fixtures.map((fixture) => fixture.entityId)).size !== 2 ||
    new Set(fixtures.map((fixture) => fixture.roomId)).size !== 2 ||
    fixtures.some(
      (fixture) => fixture.completed !== (fixture.id === "acknowledged"),
    )
  )
    throw new Error(
      "Semantic fixtures must have distinct owners/rooms and opposite completion expectations",
    );
  const context = new AsyncLocalStorage<{ phase: string; proof: string }>();
  const wires: ProviderWireEvidence[] = [];
  const wireResponses: Array<{
    fixtureId: string | null;
    status: number;
    body: string;
  }> = [];
  const modelCalls: Array<{
    input: ModelInputEvidence;
    output?: unknown;
    error?: string;
  }> = [];
  const fixtureRuns: Awaited<ReturnType<typeof runSemanticFixture>>[] = [];
  let runtimeResult: Awaited<ReturnType<typeof createTestRuntime>> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let nativeProvenance: {
    modelSha256: string;
    librarySha256: string;
    modelPath: string;
    libraryPath: string;
  } | null = null;
  const originalFetch = globalThis.fetch;
  let status = "failed";
  let error: string | null = null;
  let stage = "preflight";
  let activeFixture: SemanticFixture | null = null;
  let partialEffects: SemanticEffects | null = null;
  const finalReadbacks: Array<{ fixtureId: string; effects: SemanticEffects }> =
    [];
  const outputHandle = await open(output, "wx", 0o600);
  try {
    await mkdir(resolve(directory), { recursive: false });
    configuredModelEnvironment(model);
    if (replay) {
      const bodies = new Map(
        fixtures.map((fixture) => {
          const candidates = replay.wireResponses.filter(
            (response) =>
              response.fixtureId === fixture.id && response.status === 200,
          );
          if (candidates.length !== 1 || !candidates[0])
            throw new Error(
              `Replay requires one unambiguous complete response for ${fixture.id}`,
            );
          return [fixture.id, replayResponseBody(candidates[0].body, finish)];
        }),
      );
      server = createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          const body = activeFixture && bodies.get(activeFixture.id);
          response.writeHead(body ? 200 : 400, {
            "content-type": "application/json",
          });
          response.end(body ?? "No active replay fixture");
        });
      });
      await new Promise<void>((resolveListen) =>
        server?.listen(0, "127.0.0.1", resolveListen),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Replay listener unavailable");
      process.env.CEREBRAS_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
      process.env.CEREBRAS_API_KEY = "loopback-replay-placeholder";
    } else if (
      new URL(process.env.CEREBRAS_BASE_URL as string).href !==
      "https://api.cerebras.ai/v1"
    ) {
      throw new Error(
        "Live semantics requires the verified direct Cerebras endpoint",
      );
    }
    const endpoint = process.env.CEREBRAS_BASE_URL as string;
    const observedFetch = measuredProviderFetch(
      originalFetch,
      { text: endpoint, embedding: endpoint },
      () => context.getStore() ?? null,
      (wire) => wires.push(wire),
    );
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (replay && url.origin !== new URL(endpoint).origin)
        throw new Error("Replay forbids all remote network calls");
      const fixtureId = context.getStore()?.proof ?? null;
      const response = await observedFetch(input, init);
      if (
        url.origin === new URL(endpoint).origin &&
        url.pathname.endsWith("/chat/completions")
      ) {
        const body = await response.clone().text();
        wireResponses.push({ fixtureId, status: response.status, body });
      }
      return response;
    }) as typeof fetch;
    stage = "runtime-bootstrap";
    const { default: openai } = await import(
      "../../../plugins/plugin-openai/index.ts"
    );
    const modelsDir = process.env.MODELS_DIR;
    const embeddingModel = process.env.LOCAL_EMBEDDING_MODEL;
    if (
      !modelsDir ||
      !embeddingModel ||
      process.env.LOCAL_EMBEDDING_DIMENSIONS !== "384"
    )
      throw new Error("Installed native384 embedding configuration required");
    process.env.OPENAI_EMBEDDING_DIMENSIONS = "384";
    const { resolveFusedEmbeddingBundleRoot } = await import(
      "../../../plugins/plugin-local-inference/src/runtime/fused-embedding-bundle.ts"
    );
    const { resolveFusedLibraryPath } = await import(
      "../../../plugins/plugin-local-inference/src/services/desktop-fused-ffi-backend-runtime.ts"
    );
    const bundle = resolveFusedEmbeddingBundleRoot({
      modelsDir,
      model: embeddingModel,
    });
    const libraryPath = bundle && resolveFusedLibraryPath(bundle);
    if (!libraryPath) throw new Error("Installed native library missing");
    const modelPath = join(modelsDir, embeddingModel);
    nativeProvenance = {
      modelPath,
      libraryPath,
      modelSha256: createHash("sha256")
        .update(await readFile(modelPath))
        .digest("hex"),
      librarySha256: createHash("sha256")
        .update(await readFile(libraryPath))
        .digest("hex"),
    };
    runtimeResult = await createTestRuntime({
      characterName: "BuiltinEvaluatorSemanticAudit",
      plugins: [openai],
      embeddingDimensions: 384,
      pgliteDir: resolve(directory),
      removePgliteDirOnCleanup: false,
    });
    const { runtime } = runtimeResult;
    const { ensureLocalInferenceHandler } = await import(
      "@elizaos/plugin-local-inference/runtime"
    );
    await ensureLocalInferenceHandler(runtime);
    const useModel = runtime.useModel.bind(runtime);
    runtime.useModel = (async (modelType, params, provider) => {
      const ctx = context.getStore();
      const call: (typeof modelCalls)[number] = {
        input: captureModelInput(
          modelType,
          params,
          ctx ? { phase: "isolation", proof: ctx.proof } : null,
        ),
      };
      modelCalls.push(call);
      try {
        const result = await useModel(
          modelType,
          params,
          modelType === ModelType.TEXT_EMBEDDING
            ? "eliza-local-inference"
            : provider,
        );
        call.output = result;
        return result;
      } catch (cause) {
        // error-policy:J2 Capture complete invocation failure before preserving it.
        call.error = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      }
    }) as typeof runtime.useModel;
    const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
      text: "Semantic evaluator native embedding readiness",
    });
    if (
      !Array.isArray(embedding) ||
      embedding.length !== 384 ||
      !embedding.every(Number.isFinite) ||
      !embedding.some((value) => value !== 0)
    )
      throw new Error(
        "Native readiness did not return a real finite nonzero384 vector",
      );
    const relationships = await prepareSemanticEvaluators(runtime);
    for (const fixture of fixtures) {
      activeFixture = fixture;
      stage = `evaluate-${fixture.id}`;
      const run = await context.run(
        { phase: "semantic", proof: fixture.id },
        () => runSemanticFixture(runtime, relationships, fixture),
      );
      fixtureRuns.push(run);
      if (finish === "original") {
        if (run.result.errors.length)
          throw new Error(
            `${fixture.id}: evaluator errors ${JSON.stringify(run.result.errors)}`,
          );
        assertSemanticEffects(fixture, run.after, runtime.agentId, fixtures);
      } else {
        if (!run.result.errors.length)
          throw new Error(
            "Invalid replay output did not return an evaluator error",
          );
        assertNoSemanticEffects(run.after);
      }
    }
    stage = "final-isolation-readback";
    for (const fixture of fixtures) {
      const effects = await readSemanticEffects(
        runtime,
        relationships,
        fixture,
      );
      finalReadbacks.push({ fixtureId: fixture.id, effects });
      if (finish === "original")
        assertSemanticEffects(fixture, effects, runtime.agentId, fixtures);
      else assertNoSemanticEffects(effects);
    }
    status = "success";
    stage = "complete";
  } catch (cause) {
    // error-policy:J1 Terminal CLI evidence includes the current fixture's actual partial effects.
    error = cause instanceof Error ? cause.message : String(cause);
    if (runtimeResult && activeFixture) {
      const service = runtimeResult.runtime.getService("relationships");
      if (service instanceof RelationshipsService) {
        try {
          partialEffects = await readSemanticEffects(
            runtimeResult.runtime,
            service,
            activeFixture,
          );
        } catch (readError) {
          // error-policy:J1 Preserve readback failure explicitly alongside the original run failure.
          error += `; partial readback failed: ${readError instanceof Error ? readError.message : String(readError)}`;
        }
      }
    }
  } finally {
    try {
      await shutdownRuntime(
        runtimeResult?.runtime,
        "semantic evaluator evidence shutdown",
      );
    } catch (cleanupError) {
      // error-policy:J1 Failed teardown invalidates the CLI receipt instead of fabricating successful closure.
      status = "failed";
      error = `${error ?? ""}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
    globalThis.fetch = originalFetch;
    try {
      if (server?.listening)
        await new Promise<void>((resolveClose, reject) =>
          server?.close((cause) => (cause ? reject(cause) : resolveClose())),
        );
    } catch (closeError) {
      // error-policy:J1 Preserve listener teardown failure in the terminal report.
      status = "failed";
      error = `${error ?? ""}; replay listener close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
    }
    try {
      await outputHandle.writeFile(
        `${JSON.stringify(
          jsonEvidence({
            status,
            error,
            stage,
            sourceRevision,
            model,
            mode: replay ? "loopback-replay" : "live-provider",
            replaySource: replayPath ?? null,
            replaySourceSha256: replayBytes
              ? createHash("sha256").update(replayBytes).digest("hex")
              : null,
            replayConsumerBaseline: replay?.sourceRevision ?? null,
            replayFinish: finish,
            databaseDirectory: resolve(directory),
            retainedDatabase: true,
            fixtureDefinition:
              "Controlled stored conversation and negative action-result fixtures, not live chat replies",
            fixtures,
            fixtureRuns,
            partialEffects,
            finalReadbacks,
            nativeProvenance,
            wireEvidence: wires,
            wireResponses,
            modelCalls,
          }),
          null,
          2,
        )}\n`,
        { encoding: "utf8" },
      );
    } finally {
      await outputHandle.close();
    }
  }
  if (status !== "success")
    throw new Error(error ?? "Semantic evidence failed");
}

// error-policy:J1 The CLI publishes a failed report and returns nonzero without printing credentials.
if (import.meta.main)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
