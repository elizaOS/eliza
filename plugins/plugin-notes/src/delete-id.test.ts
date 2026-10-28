import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionResult,
  actionToJsonSchema,
  buildPlannerToolsFromActions,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  promoteSubactionsToActions,
  validateSchema,
} from "@elizaos/core";
import { test } from "vitest";
import { notesAction } from "./action.js";
import { NotesService } from "./service.js";

const children = promoteSubactionsToActions(notesAction);
const deletionCandidate = children.find(
  (action) => action.name === "NOTES_DELETE",
);
if (!deletionCandidate) throw new Error("Missing promoted Notes delete action");
const deletion = deletionCandidate;

type Context = {
  service: NotesService;
  remove: (parameters: Record<string, unknown>) => Promise<ActionResult>;
};

async function withService(run: (context: Context) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "notes-delete-id-"));
  const service = new NotesService(undefined, { stateDir: directory });
  await service.initialize();
  const runtime = {
    getService: (name: string) => (name === "notes" ? service : null),
  } as unknown as IAgentRuntime;
  const remove = async (
    parameters: Record<string, unknown>,
  ): Promise<ActionResult> => {
    const result = await deletion.handler(
      runtime,
      { content: { text: "Delete that note." } } as Memory,
      undefined,
      { parameters } as HandlerOptions,
    );
    if (!result || typeof result !== "object")
      throw new Error("Missing Notes result");
    return result;
  };
  try {
    await run({ service, remove });
  } finally {
    await service.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function seed(service: NotesService, body = "Pack a jacket.") {
  return (
    await service.createNoteWithCommit({
      content: `Alpha launch check\n${body}`,
    })
  ).value;
}

test("delete discovery exposes exact noteId without requiring text", () => {
  const schema = actionToJsonSchema(deletion);
  assert.ok(schema.properties);
  assert.ok(schema.properties.noteId);
  assert.equal(schema.required?.includes("content") ?? false, false);
  const errors: string[] = [];
  validateSchema(schema, { noteId: "note-known-id" }, "", errors);
  assert.deepEqual(errors, []);
  const tools = buildPlannerToolsFromActions([deletion]);
  assert.match(JSON.stringify(tools), /noteId/);
  assert.match(schema.properties.noteId.description ?? "", /exact-ID/);
  assert.deepEqual(deletion.roleGate, { minRole: "OWNER" });
});

test("exact ID deletes only its selected note when titles match", () =>
  withService(async ({ service, remove }) => {
    const target = await seed(service);
    const other = await seed(service, "Bring water.");
    const before = service.snapshot().revision;
    await assert.rejects(remove({ content: target.title }), {
      code: "NOTES_AMBIGUOUS_NOTE",
    });
    assert.equal(service.snapshot().revision, before);
    const result = await remove({ noteId: target.id });
    assert.equal(result.success, true);
    assert.ok(result.data);
    assert.equal(result.data.noteId, target.id);
    assert.equal(result.data.removedCount, 1);
    assert.equal(result.data.notesRevision, before + 1);
    assert.deepEqual(
      service.snapshot().notes.map((note) => note.id),
      [other.id],
    );
    assert.equal(service.snapshot().trash?.[0]?.note.id, target.id);
  }));

test("text lookup remains compatible", () =>
  withService(async ({ service, remove }) => {
    const target = await seed(service);
    const result = await remove({ content: "Alpha launch check" });
    assert.equal(result.success, true);
    assert.ok(result.data);
    assert.equal(result.data.noteId, target.id);
    assert.equal(result.data.removedCount, 1);
    assert.equal(service.snapshot().notes.length, 0);
    assert.equal(service.snapshot().trash?.[0]?.note.id, target.id);
  }));

test("conflicting ID and text selectors do not mutate notes", () =>
  withService(async ({ service, remove }) => {
    const target = await seed(service);
    const before = service.snapshot();
    const result = await remove({ noteId: target.id, content: target.title });
    assert.equal(result.success, false);
    assert.equal(result.error, "NOTES_CONFLICTING_LOOKUP");
    assert.deepEqual(service.snapshot(), before);
  }));

for (const [label, parameters, code] of [
  ["blank ID", { noteId: "  " }, "NOTES_INVALID_ID"],
  ["non-string ID", { noteId: 42 }, "NOTES_INVALID_ID"],
  ["missing selector", {}, "NOTES_MISSING_TEXT"],
] as const) {
  test(`${label} does not mutate notes`, () =>
    withService(async ({ service, remove }) => {
      await seed(service);
      const before = service.snapshot();
      const result = await remove(parameters);
      assert.equal(result.success, false);
      assert.equal(result.error, code);
      assert.deepEqual(service.snapshot(), before);
    }));
}

test("unknown IDs and IDs passed as text are never reinterpreted", () =>
  withService(async ({ service, remove }) => {
    const target = await seed(service);
    const before = service.snapshot();
    await assert.rejects(remove({ noteId: "note-missing-id" }), {
      code: "NOTES_NOT_FOUND",
    });
    await assert.rejects(remove({ content: target.id }), {
      code: "NOTES_NOT_FOUND",
    });
    assert.deepEqual(service.snapshot(), before);
  }));

test("exact ID deletion stays recoverable with the existing revision guard", () =>
  withService(async ({ service, remove }) => {
    const target = await seed(service);
    await remove({ noteId: target.id });
    const deleted = service.snapshot();
    await assert.rejects(
      service.restoreNoteWithCommit(target.id, deleted.revision - 1),
      { code: "NOTES_EDIT_CONFLICT" },
    );
    assert.deepEqual(service.snapshot(), deleted);
    const restored = await service.restoreNoteWithCommit(
      target.id,
      deleted.revision,
    );
    assert.deepEqual(restored.value, target);
    assert.deepEqual(service.snapshot().notes, [target]);
    assert.equal(service.snapshot().trash?.length, 0);
  }));
