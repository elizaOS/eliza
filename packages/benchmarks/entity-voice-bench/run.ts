#!/usr/bin/env bun
/**
 * Entity-recognition-from-voice benchmark runner (#10726 pillar 4).
 *
 * Run:  bun --conditions=eliza-source run.ts [--lane kg|llm] [--input text|audio]
 *           [--session <id>] [--out <json>] [--report <json>]
 *
 * Two lanes, both driving REAL shipped code — nothing in the extraction
 * path is reimplemented or stubbed here:
 *
 *   kg   (default, keyless)  Voice merge-engine lane. Emits the production
 *        VOICE_TURN_OBSERVED event into a real AgentRuntime with
 *        @elizaos/plugin-personal-assistant registered; the plugin's
 *        voice-observer bridge folds each turn into the knowledge-graph
 *        EntityStore/RelationshipStore (match-or-create, partner claims,
 *        merges) and round-trips VOICE_ENTITY_BOUND — exactly what happens
 *        when plugin-local-inference attributes a live voice turn. The
 *        runtime is built by @elizaos/scenario-runner's factory with the
 *        deterministic LLM proxy, so this lane needs no API keys (the
 *        merge-engine path itself makes no LLM calls).
 *
 *   llm  Conversation-extraction lane. Feeds the same transcripts through
 *        runtime.messageService.handleMessage as owner chat turns —
 *        exercising the stage-1 extract, the facts_and_relationships
 *        stage, the reflection evaluators, and plugin-personal-assistant's
 *        owner-profile extraction. Requires a live model: any provider key
 *        (GROQ/OPENAI/ANTHROPIC/GOOGLE/OPENROUTER) or ELIZA_CHAT_VIA_CLI=
 *        claude|codex on a subscription host. Voice turns are delivered as
 *        plain transcripts from the device user — the same shape an
 *        un-enrolled multi-speaker voice session produces today.
 *
 * Inputs: --input text scores extraction over the reference transcripts
 * (isolates extraction quality); --input audio replays the committed
 * asr-transcripts.json produced by the real Kokoro→ASR pipeline
 * (corpus:synth + corpus:transcribe), so the delta between the two is
 * exactly the ASR-induced entity error.
 *
 * Sessions run in child processes (fresh PGLite dir each) because the
 * knowledge-graph store is per-agent, not per-room.
 *
 * Gates: ENTITY_VOICE_REAL_REQUIRE=1 turns every skip into a failure
 * (fail-closed CI lane); baseline.json regression gate fails the run when
 * an aggregate metric drops >0.05 below the recorded baseline.
 *
 * Exit codes: 0 pass · 1 failure/regression · 2 skip (missing assets/
 * provider and REQUIRE unset).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelType,
  createMessageMemory,
  EventType,
  type Memory,
  type UUID,
  type VoiceEntityBoundPayload,
} from "@elizaos/core";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  allUtterances,
  type BenchSession,
  SESSIONS,
  sessionById,
  speakerByKey,
} from "./corpus.ts";
import {
  aggregateCells,
  type ObservedEntity,
  type ObservedRelationship,
  type PrCell,
  scoreSession,
  type SessionObservation,
  type SessionScore,
  type TurnOutcome,
} from "./metrics.ts";

type Lane = "kg" | "llm";
type InputKind = "text" | "audio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REQUIRE = ["1", "true", "yes"].includes(
  process.env.ENTITY_VOICE_REAL_REQUIRE?.trim().toLowerCase() ?? "",
);

function skip(msg: string): never {
  if (REQUIRE) {
    console.error(`[entity-voice-bench] FAIL (REQUIRE set): ${msg}`);
    process.exit(1);
  }
  console.log(`[entity-voice-bench] SKIP: ${msg}`);
  process.exit(2);
}
function fail(msg: string): never {
  console.error(`[entity-voice-bench] FAIL: ${msg}`);
  process.exit(1);
}

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

const lane = (argValue("--lane") ?? "kg") as Lane;
const input = (argValue("--input") ?? "text") as InputKind;
if (lane !== "kg" && lane !== "llm") fail(`unknown --lane ${lane}`);
if (input !== "text" && input !== "audio") fail(`unknown --input ${input}`);

// ---------------------------------------------------------------------------
// Transcript source
// ---------------------------------------------------------------------------

function loadTranscripts(): Map<string, string> {
  const map = new Map<string, string>();
  if (input === "text") {
    for (const u of allUtterances()) map.set(u.id, u.text);
    return map;
  }
  const transcriptsPath = path.join(__dirname, "asr-transcripts.json");
  if (!existsSync(transcriptsPath)) {
    skip("asr-transcripts.json missing — run corpus:synth + corpus:transcribe first");
  }
  const parsed = JSON.parse(readFileSync(transcriptsPath, "utf8")) as {
    items: { id: string; reference: string; hypothesis: string }[];
  };
  const byId = new Map(parsed.items.map((i) => [i.id, i]));
  for (const u of allUtterances()) {
    const item = byId.get(u.id);
    if (!item) skip(`asr-transcripts.json has no entry for ${u.id} — regenerate`);
    if (item.reference !== u.text) {
      skip(`asr-transcripts.json is stale for ${u.id} (reference text changed) — regenerate`);
    }
    map.set(u.id, item.hypothesis);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Shared end-state readers (knowledge graph)
// ---------------------------------------------------------------------------

interface KgEndState {
  entities: ObservedEntity[];
  relationships: ObservedRelationship[];
  attributeFacts: string[];
  entityIds: Set<string>;
  relationshipIds: Set<string>;
}

/**
 * Read the per-agent knowledge graph. The scenario factory pre-seeds
 * LifeOps simulator contacts (Alice Nguyen, Downtown Dental, ...) —
 * pre-existing state, not extraction output — so callers snapshot the
 * graph after boot and pass it as `baseline` to score only the session
 * delta.
 */
async function readKnowledgeGraph(
  runtime: import("@elizaos/core").IAgentRuntime,
  baseline?: KgEndState,
): Promise<KgEndState> {
  const service = resolveKnowledgeGraphService(runtime);
  if (!service) fail("KnowledgeGraphService is not registered on the runtime");
  const entityStore = service.getEntityStore(runtime.agentId);
  const relationshipStore = service.getRelationshipStore(runtime.agentId);
  const allPersons = (await entityStore.list({ type: "person" })).filter(
    (e) => e.entityId !== SELF_ENTITY_ID,
  );
  const nameById = new Map<string, string>(
    allPersons.map((e) => [e.entityId, e.preferredName]),
  );
  const entityIds = new Set(allPersons.map((e) => e.entityId));
  const persons = allPersons.filter(
    (e) => !baseline?.entityIds.has(e.entityId),
  );
  const entities: ObservedEntity[] = persons.map((e) => ({
    entityId: e.entityId,
    name: e.preferredName,
    attributes: Object.entries(e.attributes ?? {}).map(
      ([key, attr]) => `${key}: ${JSON.stringify(attr.value)}`,
    ),
  }));
  const allRelationships = (await relationshipStore.list()).filter(
    (r) => r.fromEntityId === SELF_ENTITY_ID,
  );
  const relationshipIds = new Set(allRelationships.map((r) => r.relationshipId));
  const relationships: ObservedRelationship[] = allRelationships
    .filter((r) => !baseline?.relationshipIds.has(r.relationshipId))
    .map((r) => ({
      toEntityId: r.toEntityId,
      toName: nameById.get(r.toEntityId) ?? r.toEntityId,
      label: `${r.type} ${String((r.metadata as { label?: unknown } | undefined)?.label ?? "")}`.trim(),
    }));
  const attributeFacts = entities.flatMap((e) =>
    e.attributes.map((a) => `${e.name} ${a}`),
  );
  return { entities, relationships, attributeFacts, entityIds, relationshipIds };
}

// ---------------------------------------------------------------------------
// KG lane — production VOICE_TURN_OBSERVED → voice-observer bridge
// ---------------------------------------------------------------------------

async function runKgSession(
  session: BenchSession,
  transcripts: Map<string, string>,
): Promise<SessionObservation> {
  const { createScenarioRuntime } = await import(
    "@elizaos/scenario-runner/runtime-factory"
  );
  const { runtime, cleanup } = await createScenarioRuntime({
    useDeterministicLlmProxy: true,
  });
  try {
    const baseline = await readKnowledgeGraph(runtime);
    const boundEvents: VoiceEntityBoundPayload[] = [];
    runtime.registerEvent(EventType.VOICE_ENTITY_BOUND, async (payload) => {
      boundEvents.push(payload as VoiceEntityBoundPayload);
    });

    const clusterToEntity = new Map<string, string>();
    const speakerEntities: Record<string, string> = {};
    const turns: TurnOutcome[] = [];

    for (const utterance of session.utterances) {
      const speaker = speakerByKey(utterance.speaker);
      const transcript = transcripts.get(utterance.id) ?? utterance.text;
      const matchedEntityId = speaker.isOwner
        ? SELF_ENTITY_ID
        : utterance.profileBound
          ? (clusterToEntity.get(utterance.cluster) ?? null)
          : null;
      const before = boundEvents.length;
      await runtime.emitEvent(EventType.VOICE_TURN_OBSERVED, {
        turnId: utterance.id,
        text: transcript,
        imprintClusterId: utterance.cluster,
        matchConfidence:
          speaker.isOwner || utterance.profileBound ? 0.92 : 0.35,
        matchedEntityId,
        isOwner: speaker.isOwner === true,
        observedAt: new Date().toISOString(),
        source: "entity-voice-bench",
      });
      const event =
        boundEvents
          .slice(before)
          .find((b) => b.imprintClusterId === utterance.cluster) ?? null;
      if (event) {
        clusterToEntity.set(utterance.cluster, event.entityId);
        if (
          !speaker.isOwner &&
          event.wasCreated &&
          !(utterance.speaker in speakerEntities)
        ) {
          speakerEntities[utterance.speaker] = event.entityId;
        }
      }
      turns.push({
        utteranceId: utterance.id,
        transcript,
        ...(event ? { boundEntityId: event.entityId } : {}),
        ...(event?.wasCreated !== undefined
          ? { wasCreated: event.wasCreated }
          : {}),
      });
    }

    const endState = await readKnowledgeGraph(runtime, baseline);
    return {
      sessionId: session.id,
      turns,
      entities: endState.entities,
      relationships: endState.relationships,
      facts: endState.attributeFacts,
      speakerEntities,
    };
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// LLM lane — real message pipeline (handleMessage)
// ---------------------------------------------------------------------------

async function runLlmSession(
  session: BenchSession,
  transcripts: Map<string, string>,
): Promise<SessionObservation> {
  const factory = await import("@elizaos/scenario-runner/runtime-factory");
  // A stray proxy env var would silently replace the live model.
  delete process.env.SCENARIO_USE_LLM_PROXY;
  delete process.env.ELIZA_SCENARIO_USE_LLM_PROXY;
  let handle: Awaited<ReturnType<typeof factory.createScenarioRuntime>>;
  try {
    handle = await factory.createScenarioRuntime({});
  } catch (error) {
    skip(
      `llm lane needs a live provider (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const { runtime, cleanup, providerName } = handle;
  console.error(
    `[entity-voice-bench] llm lane provider=${providerName} session=${session.id}`,
  );
  try {
    const baseline = await readKnowledgeGraph(runtime);
    const worldId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    const userId = crypto.randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "Owner",
      source: "entity-voice-bench",
      channelId: roomId,
      type: ChannelType.DM,
    });
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", userId, false);

    const messageService = (
      runtime as unknown as {
        messageService?: {
          handleMessage: (
            rt: unknown,
            memory: Memory,
            cb: (content: { text?: string }) => Promise<unknown[]>,
            options?: Record<string, unknown>,
          ) => Promise<{ responseContent?: { text?: string } }>;
        };
      }
    ).messageService;
    if (!messageService) fail("runtime.messageService is not initialized");

    const turns: TurnOutcome[] = [];
    for (const utterance of session.utterances) {
      const transcript = transcripts.get(utterance.id) ?? utterance.text;
      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: userId,
        roomId,
        content: {
          text: transcript,
          source: "entity-voice-bench",
          channelType: ChannelType.DM,
        },
      });
      let responseText = "";
      const result = await withTimeout(
        messageService.handleMessage(
          runtime,
          message,
          async (content: { text?: string }) => {
            if (content.text) responseText += content.text;
            return [];
          },
          {},
        ),
        240_000,
        `handleMessage(${utterance.id})`,
      );
      if (!responseText && result?.responseContent?.text) {
        responseText = result.responseContent.text;
      }
      // Post-response evaluators (reflection, owner-profile) run async.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      turns.push({ utteranceId: utterance.id, transcript });
      console.error(
        `[entity-voice-bench] ${utterance.id} -> "${responseText.slice(0, 100)}"`,
      );
    }

    // Facts written by the facts_and_relationships stage + reflection.
    const factMemories = await runtime.getMemories({
      tableName: "facts",
      roomId,
      count: 500,
    });
    const factTexts = factMemories
      .map((m) => m.content?.text ?? "")
      .filter((t) => t.length > 0);

    // Knowledge-graph writes from the PA owner-profile evaluator.
    const endState = await readKnowledgeGraph(runtime, baseline);

    return {
      sessionId: session.id,
      turns,
      entities: endState.entities,
      relationships: endState.relationships,
      facts: [...factTexts, ...endState.attributeFacts],
      // The message pipeline performs no voice binding — leave empty; the
      // recognition table then honestly reports FN for this lane.
      speakerEntities: {},
    };
  } finally {
    await cleanup();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Child mode — one session, JSON out
// ---------------------------------------------------------------------------

interface SessionResult {
  observation: SessionObservation;
  score: SessionScore;
}

async function childMain(sessionId: string, outPath: string): Promise<void> {
  const session = sessionById(sessionId);
  const transcripts = loadTranscripts();
  const observation =
    lane === "kg"
      ? await runKgSession(session, transcripts)
      : await runLlmSession(session, transcripts);
  const score = scoreSession(session, observation);
  const result: SessionResult = { observation, score };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  // PGLite keeps worker handles alive; exit explicitly once flushed.
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent mode — orchestrate sessions, aggregate, gate
// ---------------------------------------------------------------------------

interface AggregateReport {
  lane: Lane;
  input: InputKind;
  generatedAt: string;
  sessions: SessionResult[];
  aggregate: {
    creation: PrCell;
    recognition: PrCell;
    attribute: PrCell;
    disambiguation: PrCell & { falseMerges: number };
    relationships: PrCell;
  };
}

function formatCell(cell: PrCell): string {
  const fmt = (v: number | null) => (v === null ? "  n/a" : v.toFixed(2));
  return `P=${fmt(cell.precision)} R=${fmt(cell.recall)} F1=${fmt(cell.f1)} (tp=${cell.tp} fp=${cell.fp} fn=${cell.fn})`;
}

async function parentMain(): Promise<void> {
  // Fail fast on missing prerequisites before spawning children.
  loadTranscripts();

  const resultsDir = path.join(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });

  const sessions: SessionResult[] = [];
  for (const session of SESSIONS) {
    const outPath = path.join(
      resultsDir,
      `session-${lane}-${input}-${session.id}.json`,
    );
    const args = [
      "--conditions=eliza-source",
      fileURLToPath(import.meta.url),
      "--lane",
      lane,
      "--input",
      input,
      "--session",
      session.id,
      "--out",
      outPath,
    ];
    console.log(`[entity-voice-bench] session ${session.id} (${lane}/${input}) ...`);
    const child = Bun.spawnSync([process.execPath, ...args], {
      cwd: __dirname,
      env: { ...process.env },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (child.exitCode === 2) {
      skip(`session ${session.id} skipped (missing assets or provider)`);
    }
    if (child.exitCode !== 0) {
      fail(`session ${session.id} failed (exit ${child.exitCode})`);
    }
    sessions.push(JSON.parse(readFileSync(outPath, "utf8")) as SessionResult);
  }

  const aggregate = {
    creation: aggregateCells(sessions.map((s) => s.score.creation)),
    recognition: aggregateCells(sessions.map((s) => s.score.recognition)),
    attribute: aggregateCells(sessions.map((s) => s.score.attribute)),
    disambiguation: {
      ...aggregateCells(sessions.map((s) => s.score.disambiguation)),
      falseMerges: sessions.reduce(
        (a, s) => a + s.score.disambiguation.falseMerges,
        0,
      ),
    },
    relationships: aggregateCells(sessions.map((s) => s.score.relationships)),
  };

  const report: AggregateReport = {
    lane,
    input,
    generatedAt: new Date().toISOString(),
    sessions,
    aggregate,
  };
  const reportPath =
    argValue("--report") ??
    path.join(resultsDir, `report-${lane}-${input}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n[entity-voice-bench] === ${lane}/${input} aggregate ===`);
  for (const [name, cell] of Object.entries(aggregate)) {
    console.log(`  ${name.padEnd(15)} ${formatCell(cell as PrCell)}`);
  }
  console.log(`  false merges    ${aggregate.disambiguation.falseMerges}`);
  console.log(`[entity-voice-bench] report: ${reportPath}`);

  // Baseline regression gate.
  const baselinePath = path.join(__dirname, "baseline.json");
  if (existsSync(baselinePath)) {
    const baselines = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<
      string,
      Record<string, { precision: number | null; recall: number | null }>
    >;
    const baseline = baselines[`${lane}-${input}`];
    if (baseline) {
      const tolerance = 0.05;
      const regressions: string[] = [];
      for (const [name, cell] of Object.entries(aggregate)) {
        const expected = baseline[name];
        if (!expected) continue;
        const actual = cell as PrCell;
        for (const metric of ["precision", "recall"] as const) {
          const want = expected[metric];
          const got = actual[metric];
          if (want !== null && got !== null && got < want - tolerance) {
            regressions.push(
              `${name}.${metric}: ${got.toFixed(2)} < baseline ${want.toFixed(2)} - ${tolerance}`,
            );
          }
        }
      }
      if (regressions.length > 0) {
        fail(`baseline regressions:\n  ${regressions.join("\n  ")}`);
      }
      console.log(`[entity-voice-bench] baseline gate OK (${lane}-${input})`);
    } else {
      console.log(
        `[entity-voice-bench] no baseline recorded for ${lane}-${input} (report-only run)`,
      );
    }
  }
}

const sessionArg = argValue("--session");
if (sessionArg) {
  const outPath = argValue("--out");
  if (!outPath) fail("--session requires --out <json>");
  await childMain(sessionArg, outPath);
} else {
  await parentMain();
}
