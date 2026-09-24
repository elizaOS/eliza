/**
 * Cross-domain runtime acceptance using real assistant dispatch, Notes files and
 * Calendar SQL storage; only inference is supplied by strict scenario fixtures.
 * Content-bound Notes provenance is verified in Calendar metadata. Rendering
 * and navigating the associated source link require separate UI evidence.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeCommittedEffectReceipts,
  ChannelType,
  createMessageMemory,
  type JsonValue,
  ModelType,
  normalizeEffectReceipts,
  TaskService,
  type UUID,
} from "@elizaos/core";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { ApprovalService } from "../../../plugins/plugin-assistant/src/services/approval/service.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/plugin-calendar/src/internal/sql.ts";
import calendarPlugin from "../../../plugins/plugin-calendar/src/plugin.ts";
import { CalendarRepository } from "../../../plugins/plugin-calendar/src/service/CalendarRepository.ts";
import { CalendarService } from "../../../plugins/plugin-calendar/src/service/CalendarService.ts";
import notesPlugin from "../../../plugins/plugin-notes/src/index.ts";
import type { NotesDocument } from "../../../plugins/plugin-notes/src/types.ts";
import { createCalendarMutationApprovalGateway } from "../../../plugins/plugin-personal-assistant/src/actions/calendar.ts";
import { resolveExplicitOwnerApproval } from "../../../plugins/plugin-personal-assistant/src/actions/resolve-request.ts";
import { createApprovalQueue } from "../../../plugins/plugin-personal-assistant/src/lifeops/approval-queue.ts";
import { lifeOpsSchema } from "../../../plugins/plugin-personal-assistant/src/lifeops/schema.ts";
import { schedulingPlugin } from "../../../plugins/plugin-scheduling/src/index.ts";
import {
  matchesScenarioInput,
  strictActionRouteFixtures,
} from "../src/deterministic-action-fixtures.ts";
import type { DeterministicModelCall } from "../src/deterministic-model-plugin.ts";
import { createTestRuntimeWithModelProvider } from "../src/model-provider-runtime.ts";

type RecordValue = Record<string, unknown>;
type Args = Record<string, JsonValue>;
type SourceNote = { agentId: string; noteId: string; contentHash: string };
const zone = "America/Los_Angeles";
const date = "2030-10-08";
const checking = "Checking the requested item.";
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  const finish = cleanup;
  cleanup = undefined;
  await finish?.();
});
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): RecordValue {
  if (!isRecord(value)) throw new Error("Expected a structured runtime result");
  return value;
}
function evaluatorReceipt(
  call: DeterministicModelCall,
  input: string,
  action: string,
  args: Args,
): RecordValue | null {
  if (
    call.modelType !== ModelType.RESPONSE_HANDLER ||
    call.toolNames.length !== 0
  )
    return null;
  const messages = call.params.messages ?? [];
  if (
    !messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("evaluator_stage:\n"),
    )
  )
    return null;
  const inputs = messages.filter(
    (m) =>
      m.role === "user" &&
      typeof m.content === "string" &&
      matchesScenarioInput(input)(m.content),
  );
  if (
    inputs.length !== 1 ||
    typeof inputs[0].content !== "string" ||
    !matchesScenarioInput(input)(inputs[0].content)
  )
    return null;
  const calls = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === "tool-call");
  const results = messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((p) => p.type === "tool-result");
  if (calls.length !== 1 || results.length !== 1) return null;
  const tool = calls[0];
  const result = results[0];
  if (
    tool.type !== "tool-call" ||
    result.type !== "tool-result" ||
    tool.toolName !== action ||
    result.toolName !== action ||
    result.toolCallId !== tool.toolCallId
  )
    return null;
  expect(tool.input).toEqual(args);
  if (
    !isRecord(result.output) ||
    result.output.type !== "text" ||
    typeof result.output.value !== "string"
  )
    throw new Error("Missing canonical tool output");
  return record(JSON.parse(result.output.value));
}

async function scenario(label: string, withApprovals = false) {
  const stateDir = await mkdtemp(join(tmpdir(), "note-calendar-runtime-"));
  const previousState = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = stateDir;
  let stop: (() => Promise<void>) | undefined;
  cleanup = async () => {
    try {
      await stop?.();
    } finally {
      if (previousState === undefined) delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousState;
      await rm(stateDir, { recursive: true, force: true });
    }
  };
  const userId = randomUUID() as UUID;
  const embeddingInputs = new Set(["", checking]);
  const harness = await createTestRuntimeWithModelProvider({
    characterName: `${label}-${randomUUID()}`,
    plugins: [
      createAssistantPlugin(),
      notesPlugin,
      schedulingPlugin,
      calendarPlugin,
      ...(withApprovals
        ? [
            {
              name: "approval-acceptance-schema",
              description:
                "Production LifeOps schema and approval service for cross-domain acceptance",
              schema: lifeOpsSchema,
              services: [ApprovalService],
            },
          ]
        : []),
    ],
    settings: { ELIZA_ADMIN_ENTITY_ID: userId, TIMEZONE: zone },
    modelTypes: [ModelType.TEXT_LARGE, ModelType.TEXT_EMBEDDING],
    fixtures: [
      {
        name: "dimension-probe",
        match: (call) =>
          call.modelType === ModelType.TEXT_EMBEDDING && call.input === null,
        response: [1, ...Array<number>(383).fill(0)],
        times: 1,
      },
      {
        name: "declared-conversation-embeddings",
        match: (call) => {
          const input =
            typeof call.input === "string"
              ? call.input
              : isRecord(call.input) && typeof call.input.text === "string"
                ? call.input.text
                : null;
          return (
            call.modelType === ModelType.TEXT_EMBEDDING &&
            input !== null &&
            embeddingInputs.has(input)
          );
        },
        response: [1, ...Array<number>(383).fill(0)],
        times: { min: 1, max: 100 },
      },
    ],
  });
  stop = harness.cleanup;
  const { runtime } = harness;
  await Promise.all(
    runtime
      .getRegisteredServiceTypes()
      .map((type) => runtime.getServiceLoadPromise(type)),
  );
  const roomId = randomUUID() as UUID;
  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId: randomUUID() as UUID,
    userName: "Ada",
    source: "client_chat",
    channelId: roomId,
    type: ChannelType.DM,
  });
  const statePath = join(
    stateDir,
    "notes",
    "agents",
    runtime.agentId,
    "state.json",
  );
  const observed: RecordValue[] = [];
  const readRevisions = new Map<string, number>();

  async function turn(
    input: string,
    actionName: string,
    args: Args,
    reply: string,
    options: {
      paused?: "missing" | "conflict" | "stale-source";
      extraction?: Args;
      inspect?: (receipt: RecordValue) => void;
    } = {},
  ) {
    const inbound = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: userId,
      roomId,
      createdAt: Date.parse("2030-10-01T16:00:00Z"),
      content: {
        text: input,
        source: "client_chat",
        channelType: ChannelType.DM,
      },
    });
    embeddingInputs.add(input);
    embeddingInputs.add(reply);
    // The scheduler may consume a queued turn during this foreground test.
    // Its optional fixture is bound to the exact trigger identity and native schema;
    // no undeclared background model request receives a fallback response.
    harness.fixtures.register({
      name: `background-memory-${input}`,
      match: (call) => {
        if (
          call.modelType !== ModelType.TEXT_SMALL ||
          !call.params.responseSchema
        )
          return false;
        const messages = call.params.messages ?? [];
        if (
          messages.length !== 1 ||
          messages[0].role !== "user" ||
          typeof messages[0].content !== "string"
        )
          return false;
        const prompt = messages[0].content;
        if (
          !prompt.startsWith("# Task: Post-turn evaluation\n") ||
          !prompt.includes(`Agent ID: ${runtime.agentId}\n`) ||
          !prompt.includes(`Room ID: ${roomId}\n`) ||
          !prompt.includes(`Message ID: ${inbound.id}\n`) ||
          !prompt.includes(`Sender entity ID: ${userId}\n`)
        )
          return false;
        const direct = `Latest message:\n${input}\n\nAgent response messages:\n${reply}\n`;
        const deferred =
          "Latest message:\n(Job trigger is in a later evidence page. Its complete text and turn receipts remain deferred; extract only the selected source records below.)\n\nAgent response messages:\n(none)\n";
        return prompt.includes(direct) || prompt.includes(deferred);
      },
      response: (call) => {
        const schema = record(call.params.responseSchema);
        const sections = record(schema.properties);
        const prompt = (call.params.messages ?? [])
          .map((message) =>
            typeof message.content === "string" ? message.content : "",
          )
          .join("\n");
        const sourceSetId = prompt.match(/sourceSetId: ([a-f0-9]{64})/)?.[1];
        const sourceIds = [
          ...prompt.matchAll(/^\[(h\d+)(?:\]| original message )/gm),
        ].map((match) => match[1]);
        if (
          Object.hasOwn(sections, "historyRetention") &&
          (!sourceSetId || sourceIds.length === 0)
        )
          throw new Error("Retention review omitted its source binding");
        const answers: Record<string, JsonValue> = {
          factMemory: { ops: [] },
          preferences: { ops: [] },
          relationships: { relationships: [] },
          identities: { identities: [] },
          success: {
            completed:
              !options.paused &&
              !prompt.includes("(Job trigger is in a later evidence page."),
            reason: prompt.includes("(Job trigger is in a later evidence page.")
              ? "Completion judgment waits for the deferred trigger and turn receipts."
              : options.paused
                ? "The domain receipt requires clarification; no event was created."
                : "The declared operation has its actual successful tool receipt.",
          },
          experiencePatterns: { experiences: [] },
          ...(sourceSetId
            ? {
                historyRetention: {
                  sourceSetId,
                  complete: true,
                  retainSourceIds: sourceIds,
                  deferSourceIds: [],
                  uncertainSourceIds: [],
                  dependencyGroups: [],
                  referenceMessageIds: [],
                },
              }
            : {}),
        };
        expect(schema.required).toEqual(
          Object.keys(sections).filter(
            (name) => name !== "restoreContextBefore",
          ),
        );
        const response: Record<string, JsonValue> = {};
        for (const name of Object.keys(sections)) {
          if (name === "restoreContextBefore") continue;
          if (!Object.hasOwn(answers, name))
            throw new Error(`Undeclared background evaluator: ${name}`);
          response[name] = answers[name];
        }
        return JSON.stringify(response);
      },
      times: { min: 0, max: 2 },
    });
    const fixtures = strictActionRouteFixtures({
      input,
      actionName,
      args,
      contextIds: actionName === "CALENDAR" ? ["calendar", "notes"] : ["notes"],
      messageToUser: checking,
    });
    // Reuse the exact Stage-1 and native planner wire fixtures, replacing only
    // their success-only evaluator with a receipt-aware scenario evaluator.
    harness.fixtures.register(...fixtures.slice(0, 2));
    if (options.extraction) {
      const extraction = options.extraction;
      harness.fixtures.register({
        name: `extract-create-${input}`,
        match: {
          modelType: ModelType.TEXT_LARGE,
          prompt: (prompt) =>
            prompt.startsWith(
              "Extract calendar event creation fields from the request.",
            ) &&
            prompt.includes(
              `FINAL CURRENT REQUEST (authoritative; resolve only this request against its relevant prior turns):\n${input}\n`,
            ),
        },
        response: (call) => {
          expect(call.params.temperature).toBe(0);
          expect(call.params.responseSchema).toMatchObject({
            type: "object",
            additionalProperties: false,
            required: Object.keys(extraction),
          });
          return JSON.stringify(extraction);
        },
        times: 1,
      });
    }
    harness.fixtures.register({
      name: `evaluate-${input}`,
      match: (call) => evaluatorReceipt(call, input, actionName, args) !== null,
      response: (call) => {
        const receipt = evaluatorReceipt(call, input, actionName, args);
        if (!receipt) throw new Error("Correlated tool receipt disappeared");
        observed.push(receipt);
        const effects = normalizeEffectReceipts(receipt.effectReceipts);
        const committed = activeCommittedEffectReceipts(effects);
        if (options.paused) {
          expect(receipt.success).toBe(false);
          const data = record(receipt.data);
          expect(data.awaitingUserInput).toBe(true);
          expect(data.requiresInput).toBe(true);
          expect(committed).toHaveLength(0);
          if (options.paused === "stale-source") {
            expect(data.error).toBe("CALENDAR_NOTE_SOURCE_CONFLICT");
            expect(
              effects.some(
                (effect) =>
                  effect.outcome === "failed" &&
                  effect.failure.acceptance === "rejected" &&
                  effect.failure.code === "CALENDAR_NOTE_SOURCE_CONFLICT",
              ),
            ).toBe(true);
          } else {
            expect(effects.some((effect) => effect.outcome === "noop")).toBe(
              true,
            );
          }
          if (options.paused === "conflict") {
            const availability = record(data.availability);
            expect(availability.definitive).toBe(true);
            expect(
              Array.isArray(availability.conflicts) &&
                availability.conflicts.length > 0,
            ).toBe(true);
          }
        } else {
          expect(receipt).toMatchObject({ success: true });
          if (actionName === "CALENDAR") {
            expect(committed).toHaveLength(1);
            expect(committed[0].operation).toBe("calendar.event.create");
          }
        }
        options.inspect?.(receipt);
        return {
          thought: options.paused
            ? "The actual no-op receipt requires user input; no calendar write completed."
            : "The correlated tool receipt proves the requested operation completed.",
          success: !options.paused,
          decision: "FINISH",
          messageToUser: reply,
          effectReceiptIds: committed.map((effect) => effect.receiptId),
        };
      },
      times: 1,
    });
    const replies: string[] = [];
    if (!runtime.messageService)
      throw new Error("Assistant message service did not start");
    await runtime.messageService.handleMessage(
      runtime,
      inbound,
      async (message) => {
        if (message.text) replies.push(message.text);
        return [];
      },
    );
    expect(replies).toContain(reply);
    if (options.paused)
      expect(replies.join("\n")).not.toMatch(
        /(?:created|booked|scheduled|saved) (?:your |the )?event/i,
      );
    const history = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 100,
    });
    expect(
      history.some(
        (m) => m.entityId === runtime.agentId && m.content.text === reply,
      ),
    ).toBe(true);
    return observed[observed.length - 1];
  }
  async function notes() {
    const bytes = await readFile(statePath);
    const parsed: NotesDocument = JSON.parse(bytes.toString("utf8"));
    return {
      bytes,
      parsed,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  async function createNote(content: string) {
    embeddingInputs.add(content);
    await turn(
      `Save this exact note:\n${content}`,
      "NOTES_CREATE",
      { content },
      `Saved the ${label} note.`,
    );
    const stored = await notes();
    const title = content.split("\n")[0];
    const body = content.substring(title.length + 1);
    const note = stored.parsed.notes.find(
      (entry) => entry.title === title && entry.body === body,
    );
    if (!note) throw new Error("Real Notes storage lacks the created note");
    return note;
  }
  async function readNote(note: NotesDocument["notes"][number]) {
    const receipt = await turn(
      `Read note ${note.id} exactly.`,
      "NOTES_GET",
      { noteId: note.id },
      `${note.title}\n${note.body}`,
    );
    const data = record(receipt.data);
    expect(data.lookupMode).toBe("exact_id");
    if (typeof data.notesRevision !== "number")
      throw new Error("Notes read omitted its revision");
    readRevisions.set(note.id, data.notesRevision);
    expect(data.count).toBe(1);
    expect(data.notes).toEqual([expect.objectContaining(note)]);
    const returned = record((data.notes as RecordValue[])[0]);
    const source = record(returned.sourceNote);
    const expectedSource: SourceNote = {
      agentId: runtime.agentId,
      noteId: note.id,
      contentHash: createHash("sha256")
        .update(
          JSON.stringify([runtime.agentId, note.id, note.title, note.body]),
        )
        .digest("hex"),
    };
    expect(source).toEqual(expectedSource);
    return expectedSource;
  }
  async function events() {
    return executeRawSql(
      runtime,
      `SELECT * FROM app_calendar.life_calendar_events WHERE agent_id = ${sqlQuote(runtime.agentId)} ORDER BY id`,
    );
  }
  function readRevision(noteId: string): number {
    const revision = readRevisions.get(noteId);
    if (revision === undefined)
      throw new Error("No complete read precedes the edit");
    return revision;
  }
  async function drainBackground() {
    const service = runtime.getService<TaskService>(TaskService.serviceType);
    if (!service) throw new Error("Real TaskService did not start");
    await service.runTick(await runtime.getTasksByName("POST_TURN_MEMORY"));
  }
  return {
    drainBackground,
    harness,
    runtime,
    userId,
    roomId,
    turn,
    notes,
    createNote,
    readNote,
    readRevision,
    events,
  };
}
function extraction(
  title: string,
  description: string,
  startAt: string | null,
  endAt: string | null,
): Args {
  return {
    requiresInput: startAt === null,
    clarification: startAt === null ? "What exact time should I use?" : null,
    title,
    description,
    location: null,
    startAt,
    endAt,
    timeZone: zone,
    recurrence: null,
    travelOriginAddress: null,
    durationMinutes: 30,
    isShortPreparation: false,
  };
}
function calendarArgs(
  title: string,
  description: string,
  start: string,
  end: string,
  sourceNote?: SourceNote,
): Args {
  return {
    subaction: "create_event",
    title,
    details: {
      grantId: "eliza-calendar",
      calendarId: "primary",
      start,
      end,
      timeZone: zone,
      description,
      ...(sourceNote ? { sourceNote } : {}),
    },
  };
}

test("NOTE-14 runtime: content-bound note becomes one event and stale source cannot create another", async () => {
  const s = await scenario("NOTE-14");
  const note = await s.createNote(
    `Ada review\nReview the notebook on ${date}, 10:00–10:30 America/Los_Angeles.`,
  );
  await s.createNote(
    "Ada review draft\nUnrelated draft; do not schedule or edit.",
  );
  const sourceNote = await s.readNote(note);
  const before = await s.notes();
  expect(await s.events()).toHaveLength(0);
  // Human-readable description and typed provenance are independently preserved.
  const description = `Source note ID: ${note.id}\n${note.body}`;
  const start = `${date}T10:00:00-07:00`;
  const end = `${date}T10:30:00-07:00`;
  const createdReceipt = await s.turn(
    `Create Ada review on my built-in Eliza calendar for ${date} from 10:00 to 10:30 America/Los_Angeles, using note ${note.id}. Preserve this exact description:\n${description}`,
    "CALENDAR",
    calendarArgs("Ada review", description, start, end, sourceNote),
    "Created Ada review for October 8, 2030, 10:00–10:30 America/Los_Angeles.",
    { extraction: extraction("Ada review", description, start, end) },
  );
  const rows = await s.events();
  expect(rows).toHaveLength(1);
  expect(
    activeCommittedEffectReceipts(
      normalizeEffectReceipts(createdReceipt.effectReceipts),
    )[0].resource.id,
  ).toBe(rows[0].id);
  expect(record(record(createdReceipt.data).event).id).toBe(rows[0].id);
  expect(JSON.parse(String(rows[0].metadata_json)).sourceNote).toEqual(
    sourceNote,
  );
  expect(record(record(createdReceipt.data).event).metadata).toMatchObject({
    sourceNote,
  });
  expect(rows[0]).toMatchObject({
    provider: "eliza",
    grant_id: "eliza-calendar",
    calendar_id: "primary",
    title: "Ada review",
    description,
    timezone: zone,
  });
  expect(new Date(String(rows[0].start_at)).toISOString()).toBe(
    `${date}T17:00:00.000Z`,
  );
  expect(new Date(String(rows[0].end_at)).toISOString()).toBe(
    `${date}T17:30:00.000Z`,
  );
  expect((await s.notes()).bytes).toEqual(before.bytes);
  expect((await s.notes()).hash).toBe(before.hash);
  const replacement = `Review the revised notebook on ${date}; the original plan is outdated.`;
  await s.turn(
    `Change only the body of note ${note.id} to this exact text:\n${replacement}`,
    "NOTES_PATCH",
    {
      target: { kind: "id", value: note.id },
      changes: [{ field: "body", value: replacement }],
      expectedRevision: s.readRevision(note.id),
    },
    "Updated the NOTE-14 note body.",
  );
  const revisedNotes = await s.notes();
  expect(
    revisedNotes.parsed.notes.find((entry) => entry.id === note.id)?.body,
  ).toBe(replacement);
  expect(revisedNotes.hash).not.toBe(before.hash);
  const revisedNote = revisedNotes.parsed.notes.find(
    (entry) => entry.id === note.id,
  );
  if (!revisedNote) throw new Error("Updated source note disappeared");
  const refreshedSource = await s.readNote(revisedNote);
  expect(refreshedSource.noteId).toBe(sourceNote.noteId);
  expect(refreshedSource.agentId).toBe(sourceNote.agentId);
  expect(refreshedSource.contentHash).not.toBe(sourceNote.contentHash);
  expect(
    revisedNotes.parsed.notes.filter((entry) => entry.id !== note.id),
  ).toEqual(before.parsed.notes.filter((entry) => entry.id !== note.id));
  const staleStart = `${date}T12:00:00-07:00`;
  const staleEnd = `${date}T12:30:00-07:00`;
  await s.turn(
    `Create a second Ada review from note ${note.id}, using the earlier source reference, for ${date}, 12:00–12:30 America/Los_Angeles.`,
    "CALENDAR",
    calendarArgs("Ada review", description, staleStart, staleEnd, sourceNote),
    "The source note changed. Nothing was created. Read the current note before scheduling it.",
    {
      paused: "stale-source",
      extraction: extraction("Ada review", description, staleStart, staleEnd),
    },
  );
  expect(await s.events()).toEqual(rows);
  expect((await s.notes()).bytes).toEqual(revisedNotes.bytes);
  const foreignSource = { ...refreshedSource, agentId: randomUUID() };
  await s.turn(
    `Schedule Ada review from note ${note.id} on ${date}, 12:00–12:30 America/Los_Angeles.`,
    "CALENDAR",
    calendarArgs(
      "Ada review",
      description,
      staleStart,
      staleEnd,
      foreignSource,
    ),
    "That source reference belongs to another agent. Nothing was created.",
    {
      paused: "stale-source",
      extraction: extraction("Ada review", description, staleStart, staleEnd),
    },
  );
  expect(await s.events()).toEqual(rows);
  expect((await s.notes()).bytes).toEqual(revisedNotes.bytes);
  await s.turn(
    `Delete only the note whose exact body is: ${replacement}`,
    "NOTES_DELETE",
    { content: replacement },
    "Deleted the requested NOTE-14 note.",
  );
  const afterDelete = await s.notes();
  expect(afterDelete.parsed.notes.some((entry) => entry.id === note.id)).toBe(
    false,
  );
  expect(afterDelete.parsed.notes).toEqual(
    before.parsed.notes.filter((entry) => entry.id !== note.id),
  );
  await s.turn(
    `Create Ada review from the previously read note ${note.id} on ${date}, 12:00–12:30 America/Los_Angeles. Preserve the old description.`,
    "CALENDAR",
    calendarArgs(
      "Ada review",
      description,
      staleStart,
      staleEnd,
      refreshedSource,
    ),
    "The source note is unavailable. Nothing was created.",
    {
      paused: "stale-source",
      extraction: extraction("Ada review", description, staleStart, staleEnd),
    },
  );
  expect(await s.events()).toEqual(rows);
  expect((await s.notes()).bytes).toEqual(afterDelete.bytes);
  const calendar = s.runtime.getService<CalendarService>(
    CalendarService.serviceType,
  );
  if (!calendar) throw new Error("Real CalendarService is unavailable");
  const savedEvent = await calendar.getCalendarEventById(String(rows[0].id));
  if (!savedEvent) throw new Error("Created calendar event disappeared");
  const repository = new CalendarRepository(s.runtime);
  // Exercise the actual SQL refresh boundary without claiming an external
  // provider transport ran. A refreshed record replaces provider metadata,
  // while the original content-bound provenance remains authoritative.
  await repository.upsertCalendarEvent({
    ...savedEvent,
    metadata: {
      ...savedEvent.metadata,
      staleProviderField: "remove-on-next-refresh",
    },
  });
  const refreshedEvent = {
    ...savedEvent,
    metadata: {
      version: 2,
      etag: '"eliza-2"',
      refreshMarker: "new-provider-metadata",
    },
  };
  await repository.upsertCalendarEvent(refreshedEvent);
  const expectedMetadata = {
    version: 2,
    etag: '"eliza-2"',
    refreshMarker: "new-provider-metadata",
    sourceNote,
  };
  expect(refreshedEvent.metadata).toEqual(expectedMetadata);
  expect(
    (await calendar.getCalendarEventById(savedEvent.id))?.metadata,
  ).toEqual(expectedMetadata);
  const refreshedRows = await s.events();
  expect(refreshedRows).toHaveLength(1);
  expect(JSON.parse(String(refreshedRows[0].metadata_json))).toEqual(
    expectedMetadata,
  );
  expect(refreshedRows[0].id).toBe(savedEvent.id);
  expect((await s.notes()).bytes).toEqual(afterDelete.bytes);
  await s.drainBackground();
  s.harness.assertFixturesConsumed();
}, 180_000);

test("NOTE-15 runtime: missing time and real conflict pause until the user supplies a free time", async () => {
  const s = await scenario("NOTE-15");
  const note = await s.createNote(
    "Ada review\nReview the notebook; time not decided.",
  );
  await s.createNote("Ada review draft\nUnrelated note must remain unchanged.");
  const sourceNote = await s.readNote(note);
  const notesBefore = await s.notes();
  const busyStart = `${date}T10:00:00-07:00`;
  const busyEnd = `${date}T10:30:00-07:00`;
  await s.turn(
    `Create Existing commitment on my built-in Eliza calendar for ${date}, 10:00–10:30 America/Los_Angeles.`,
    "CALENDAR",
    calendarArgs("Existing commitment", "", busyStart, busyEnd),
    "Created Existing commitment for October 8, 2030, 10:00–10:30 America/Los_Angeles.",
    { extraction: extraction("Existing commitment", "", busyStart, busyEnd) },
  );
  const baseline = await s.events();
  expect(baseline).toHaveLength(1);
  const description = `Source note ID: ${note.id}\n${note.body}`;
  // Adversarial planner timestamps must not substitute for missing user timing.
  await s.turn(
    `Put note ${note.id}, Ada review, on my built-in Eliza calendar. Include this exact description:\n${description}`,
    "CALENDAR",
    calendarArgs("Ada review", description, busyStart, busyEnd, sourceNote),
    "What date and exact time should I use for Ada review? Nothing was created.",
    {
      paused: "missing",
      extraction: extraction("Ada review", description, null, null),
    },
  );
  expect(await s.events()).toEqual(baseline);
  expect((await s.notes()).bytes).toEqual(notesBefore.bytes);
  await s.turn(
    `For Ada review from note ${note.id}, use ${date}, 10:00–10:30 America/Los_Angeles. Keep the source description.`,
    "CALENDAR",
    calendarArgs("Ada review", description, busyStart, busyEnd, sourceNote),
    "That time conflicts with Existing commitment. Nothing was created. Which other time should I use?",
    {
      paused: "conflict",
      extraction: extraction("Ada review", description, busyStart, busyEnd),
    },
  );
  expect(await s.events()).toEqual(baseline);
  expect((await s.notes()).bytes).toEqual(notesBefore.bytes);
  const start = `${date}T11:00:00-07:00`;
  const end = `${date}T11:30:00-07:00`;
  await s.turn(
    `Create Ada review from note ${note.id} instead on ${date}, 11:00–11:30 America/Los_Angeles. Keep the source description.`,
    "CALENDAR",
    calendarArgs("Ada review", description, start, end, sourceNote),
    "Created Ada review for October 8, 2030, 11:00–11:30 America/Los_Angeles.",
    { extraction: extraction("Ada review", description, start, end) },
  );
  const rows = await s.events();
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === baseline[0].id)).toEqual(baseline[0]);
  const added = rows.find((row) => row.id !== baseline[0].id);
  expect(added).toMatchObject({
    title: "Ada review",
    description,
    provider: "eliza",
    timezone: zone,
  });
  expect(JSON.parse(String(added?.metadata_json)).sourceNote).toEqual(
    sourceNote,
  );
  expect(new Date(String(added?.start_at)).toISOString()).toBe(
    `${date}T18:00:00.000Z`,
  );
  expect(new Date(String(added?.end_at)).toISOString()).toBe(
    `${date}T18:30:00.000Z`,
  );
  expect((await s.notes()).bytes).toEqual(notesBefore.bytes);
  await s.drainBackground();
  s.harness.assertFixturesConsumed();
}, 180_000);

// This crosses the actual delayed-approval boundary explicitly. Conversational
// CALENDAR bypasses approval for built-in events; this test does not pretend
// that ordinary built-in scheduling exercises the pending queue.
test.each([false, true])(
  "NOTE-14 delayed approval retains source and rejects stale content (edit=%s)",
  async (editSource) => {
    const s = await scenario(`NOTE-14-approval-${editSource}`, true);
    const note = await s.createNote(
      "Approval review\nRead the original notebook.",
    );
    const sourceNote = await s.readNote(note);
    const calendar = s.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw new Error("Real CalendarService did not start");
    expect(s.runtime.getService(ApprovalService.serviceType)).toBeInstanceOf(
      ApprovalService,
    );
    const request = await calendar.prepareCalendarEventCreate(
      new URL("http://internal.local/api/calendar"),
      {
        title: "Approval review",
        startAt: `${date}T13:00:00-07:00`,
        endAt: `${date}T13:30:00-07:00`,
        timeZone: zone,
        grantId: "eliza-calendar",
        calendarId: "primary",
        description: note.body,
        sourceNote,
      },
    );
    const message = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: s.userId,
      roomId: s.roomId,
      createdAt: Date.now(),
      content: {
        text: `Prepare Approval review from note ${note.id} for ${date}, 13:00–13:30 America/Los_Angeles; wait for my approval.`,
        source: "client_chat",
        channelType: ChannelType.DM,
      },
    });
    const pending = await createCalendarMutationApprovalGateway().schedule({
      runtime: s.runtime,
      message,
      request,
    });
    expect(pending.state).toBe("pending");
    const queue = createApprovalQueue(s.runtime, {
      agentId: s.runtime.agentId,
    });
    const stored = await queue.byId(pending.requestId, s.userId);
    expect(stored?.state).toBe("pending");
    expect(stored?.payload).toMatchObject({
      sourceNote,
      title: "Approval review",
    });
    const approvalRows = await executeRawSql(
      s.runtime,
      `SELECT payload, state FROM approval_requests WHERE agent_id = ${sqlQuote(s.runtime.agentId)} AND id = ${sqlQuote(pending.requestId)}`,
    );
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0].state).toBe("pending");
    const storedPayload =
      typeof approvalRows[0].payload === "string"
        ? JSON.parse(approvalRows[0].payload)
        : approvalRows[0].payload;
    expect(storedPayload).toMatchObject({ sourceNote });
    expect(await s.events()).toHaveLength(0);
    if (editSource) {
      await s.turn(
        `Change only the body of note ${note.id} to exactly: Read the revised notebook.`,
        "NOTES_PATCH",
        {
          target: { kind: "id", value: note.id },
          changes: [{ field: "body", value: "Read the revised notebook." }],
          expectedRevision: s.readRevision(note.id),
        },
        "Updated the approval source note.",
      );
      const updated = (await s.notes()).parsed.notes.find(
        (entry) => entry.id === note.id,
      );
      if (!updated) throw new Error("Edited source note disappeared");
      const freshReference = await s.readNote(updated);
      expect(freshReference.contentHash).not.toBe(sourceNote.contentHash);
      expect(
        (await queue.byId(pending.requestId, s.userId))?.payload,
      ).toMatchObject({ sourceNote });
    }
    const beforeApproval = await s.notes();
    // The identity comes from this runtime's authenticated owner setup, never
    // from a fabricated role resolver or overridden approval implementation.
    const result = await resolveExplicitOwnerApproval(s.runtime, {
      subjectUserId: s.userId,
      requestId: pending.requestId,
      decision: "approve",
      reason: "Approve the exact pending draft.",
    });
    const attempts = await executeRawSql(
      s.runtime,
      `SELECT state, receipt_json, last_failure_json FROM app_lifeops.life_calendar_mutation_attempts WHERE agent_id = ${sqlQuote(s.runtime.agentId)} AND approval_request_id = ${sqlQuote(pending.requestId)}`,
    );
    expect(attempts).toHaveLength(1);
    if (editSource) {
      expect(result.success).toBe(false);
      expect(result.data).toMatchObject({
        error: "CALENDAR_NOTE_SOURCE_CONFLICT",
        state: "expired",
        executed: false,
        safeToRetry: false,
      });
      expect(attempts[0].state).toBe("invalidated");
      expect(attempts[0].receipt_json).toBeNull();
      expect(JSON.parse(String(attempts[0].last_failure_json))).toMatchObject({
        code: "CALENDAR_NOTE_SOURCE_CONFLICT",
      });
      expect(await s.events()).toHaveLength(0);
      expect(
        activeCommittedEffectReceipts(
          normalizeEffectReceipts(result.effectReceipts),
        ),
      ).toHaveLength(0);
    } else {
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ state: "done", executed: true });
      expect(attempts[0].state).toBe("succeeded");
      const events = await s.events();
      expect(events).toHaveLength(1);
      expect(events[0].title).toBe("Approval review");
      expect(JSON.parse(String(events[0].metadata_json)).sourceNote).toEqual(
        sourceNote,
      );
      expect(new Date(String(events[0].start_at)).toISOString()).toBe(
        `${date}T20:00:00.000Z`,
      );
      expect(new Date(String(events[0].end_at)).toISOString()).toBe(
        `${date}T20:30:00.000Z`,
      );
      const receipt = record(JSON.parse(String(attempts[0].receipt_json)));
      expect(receipt.providerEventId).toBe(events[0].external_event_id);
      expect(receipt.sourceId).toBe("eliza-calendar");
      const replay = await resolveExplicitOwnerApproval(s.runtime, {
        subjectUserId: s.userId,
        requestId: pending.requestId,
        decision: "approve",
        reason: "Repeat the same explicit decision.",
      });
      expect(replay.success).toBe(true);
      expect(await s.events()).toEqual(events);
    }
    expect((await s.notes()).bytes).toEqual(beforeApproval.bytes);
    await s.drainBackground();
    s.harness.assertFixturesConsumed();
  },
  180_000,
);
