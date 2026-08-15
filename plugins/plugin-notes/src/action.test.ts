/**
 * Pins the NOTES action's operation-parsing contract against a real
 * `NotesService` over a temp-file store. The case that matters: an operation
 * name this action does not implement must NOT degrade into a read. The action
 * advertises DELETE_NOTE / SEARCH_NOTES / UPDATE_NOTE as similes, so a planner
 * emitting `action: "remove"` is expected traffic — and silently listing the
 * notes in response contradicts this action's own routing contract.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  satisfiesRoleGate,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { notesAction } from "./action.js";
import { NOTES_SERVICE_TYPE, NotesService } from "./service.js";
import { NotesStore } from "./store.js";
import { parseNoteContent } from "./validation.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function harness(): Promise<IAgentRuntime> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-action-"));
  tmpDirs.push(dir);
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath: path.join(dir, "notes.json") }),
  });
  await service.initialize();
  return {
    getService: (type: string) =>
      type === NOTES_SERVICE_TYPE ? service : null,
  } as unknown as IAgentRuntime;
}

const message = { content: { text: "" } } as unknown as Memory;

async function run(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await notesAction.handler(runtime, message, undefined, {
    parameters,
  } as never);
  if (!result) throw new Error("NOTES action returned no result.");
  return result;
}

describe("NOTES operation parsing", () => {
  it("denies every non-owner role before the handler can access the store", () => {
    expect(notesAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(satisfiesRoleGate(["GUEST"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["USER"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["ADMIN"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["OWNER"], notesAction.roleGate)).toBe(true);
  });

  it("refuses an operation it does not implement instead of listing", async () => {
    const runtime = await harness();
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    // "remove" is plausible planner output: DELETE_NOTE is an advertised simile.
    const result = await run(runtime, {
      action: "remove",
      content: "spare key",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOTES_UNKNOWN_OP");
    // The failure names what it CAN do, and never renders the note list.
    expect(result.text).toContain("delete");
    expect(result.text).not.toContain("spare key under the mat");
  });

  it("still reads when no operation was named at all", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "wifi is on the fridge" });

    const result = await run(runtime, {});

    expect(result.success).toBe(true);
    expect(result.text).toContain("wifi is on the fridge");
  });

  it("keeps a topic-scoped read from exposing unrelated notes", async () => {
    const runtime = await harness();
    await run(runtime, {
      action: "create",
      content: "the plumber comes thursday morning",
    });
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    const match = await run(runtime, { action: "list", content: "PLUMBER" });
    expect(match.text).toContain("plumber comes thursday");
    expect(match.text).not.toContain("spare key");
    expect(match.data).toMatchObject({
      count: 1,
      total: 2,
      filterApplied: true,
    });

    const absent = await run(runtime, { action: "list", query: "dentist" });
    expect(absent.text).toBe("you don't have any matching notes.");
    expect(absent.text).not.toContain("spare key");
    expect(absent.data).toMatchObject({
      count: 0,
      total: 2,
      filterApplied: true,
    });
  });

  it("lets the owner create, search/list, update, and delete in one store", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "bins go out tuesday",
    });
    expect(created.success).toBe(true);
    expect(created.text).toContain("saved a note");

    const listed = await run(runtime, { action: "list" });
    expect(listed.success).toBe(true);
    expect(listed.text).toContain("bins go out tuesday");

    const updated = await run(runtime, {
      action: "update",
      content: "bins",
      body: "bins go out wednesday",
    });
    expect(updated.success).toBe(true);
    expect(updated.text).toContain("bins go out wednesday");

    const deleted = await run(runtime, {
      action: "delete",
      content: "wednesday",
    });
    expect(deleted.success).toBe(true);
    expect(deleted.text).toContain("deleted the note");

    const after = await run(runtime, { action: "list" });
    expect(after.text).toContain("don't have any notes");
  });
});

describe("identical-duplicate notes", () => {
  async function seedLegacyCopies(
    runtime: IAgentRuntime,
    content: string,
    copies: number,
  ): Promise<NotesService> {
    const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
    if (!service) throw new Error("NotesService missing from harness");
    const original = await service.createNote(parseNoteContent(content));
    await service.store.transact((draft) => {
      for (let index = 1; index < copies; index += 1) {
        draft.notes.push({ ...original, id: `legacy-copy-${index}` });
      }
    });
    return service;
  }

  it("makes concurrent identical creates one replayable logical note", async () => {
    const runtime = await harness();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(runtime, { action: "create", content: "i need to buy milk" }),
      ),
    );

    expect(
      results.filter((result) => result.data?.replayed === false),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.data?.replayed === true),
    ).toHaveLength(3);
    const listed = await run(runtime, { action: "list" });
    expect(listed.data).toMatchObject({ count: 1, total: 1 });
  });

  it("deletes every byte-identical copy as one logical note", async () => {
    const runtime = await harness();
    await seedLegacyCopies(runtime, "i need to buy milk", 4);
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    const result = await run(runtime, { action: "delete", content: "milk" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("removed 4 identical copies");

    const after = await run(runtime, { action: "list" });
    expect(after.text).not.toContain("milk");
    expect(after.text).toContain("spare key");
  });

  it("still refuses genuinely differing matches as ambiguous", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "buy milk at aldi" });
    await run(runtime, { action: "create", content: "buy milk for the cat" });

    await expect(
      run(runtime, { action: "delete", content: "milk" }),
    ).rejects.toMatchObject({ code: "NOTES_AMBIGUOUS_NOTE" });
  });

  it("updates one logical note and consolidates its identical stored copies", async () => {
    const runtime = await harness();
    await seedLegacyCopies(runtime, "i need to buy milk", 4);

    const result = await run(runtime, {
      action: "update",
      content: "milk",
      body: "i already bought milk",
    });

    expect(result.text).toContain("consolidated 4 identical copies");
    expect(result.data).toMatchObject({ consolidatedCount: 3 });
    const after = await run(runtime, { action: "list" });
    expect(after.data).toMatchObject({ count: 1, total: 1 });
    expect(after.text).toContain("i already bought milk");
  });

  it("keeps same-text notes with different visible colors distinct", async () => {
    const runtime = await harness();
    const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
    if (!service) throw new Error("NotesService missing from harness");
    await service.createNote({ title: "buy milk", body: "", color: "yellow" });
    await service.createNote({ title: "buy milk", body: "", color: "green" });

    await expect(
      run(runtime, { action: "delete", content: "buy milk" }),
    ).rejects.toMatchObject({ code: "NOTES_AMBIGUOUS_NOTE" });

    const deleted = await run(runtime, {
      action: "delete",
      content: "buy milk green",
    });
    expect(deleted.success).toBe(true);
    expect(service.listNotes().map((note) => note.color)).toEqual(["yellow"]);
  });
});
