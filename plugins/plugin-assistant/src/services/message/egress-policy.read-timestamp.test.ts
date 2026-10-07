/** Current read timestamp metadata must not become a fabricated write claim. */
import type { ActionResult, Memory } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import {
  enforceEffectGroundedVisibleContent,
  evaluatePlannedReplyEgress,
  resolvePlannedReplyEgress,
} from "./egress-policy.ts";

const at = "2026-09-28T03:57:25.000Z";
const timeZone = "America/Los_Angeles";
const label = new Intl.DateTimeFormat("en-US", {
  timeZone,
  dateStyle: "medium",
  timeStyle: "long",
}).format(new Date(at));
const reply = `Most recently updated note:\n\nTitle: Test note\nBody: Preserve two  spaces.\nSaved: ${label}`;
const read: ActionResult = {
  success: true,
  transcriptVisibility: "internal",
  data: {
    actionName: "NOTES_LIST",
    op: "list",
    readOnlyOperation: true,
    notesRevision: 26,
    count: 1,
    notes: [
      {
        id: "note-1",
        title: "Test note",
        body: "\nPreserve two  spaces.",
        createdAt: at,
        updatedAt: at,
      },
    ],
    selection: {
      kind: "latest",
      field: "updatedAt",
      at,
      display: { label, timeZone, source: "explicit" },
    },
  },
};
const message = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
  content: {
    text: "Read my latest saved note and its saved local date/time. Do not change anything.",
  },
} as Memory;
const check = (
  text: string,
  results: ActionResult[] = [read],
  pendingWork = false,
) =>
  evaluatePlannedReplyEgress({
    reply: text,
    actionResults: results,
    actions: [],
    pendingWork,
  });
describe("grounded read timestamp labels", () => {
  it("accepts the captured field layout through planned and visible egress without a rewrite", async () => {
    expect(check(reply)).toEqual({ verdict: "allow" });
    const useModel = vi.fn(async () => {
      throw new Error("No rewrite needed");
    });
    const runtime = createMockRuntime({
      useModel,
      logger: { warn: vi.fn() } as never,
    });
    await expect(
      resolvePlannedReplyEgress({
        runtime,
        message,
        reply,
        actionResults: [read],
      }),
    ).resolves.toEqual({ text: reply, effectReceiptIds: [] });
    const delivered = await enforceEffectGroundedVisibleContent(
      runtime,
      message,
      { text: reply },
      undefined,
      async () => ({
        context: "Complete authorized context",
        actionResults: [read],
        pendingToolCalls: [],
        evaluatorOutputs: [],
        ownerExclusiveDisclosureUsed: false,
      }),
    );
    expect(delivered.text).toBe(reply);
    expect(delivered.effectReceiptIds).toBeUndefined();
    expect(useModel).not.toHaveBeenCalled();
    expect(runtime.logger.warn).not.toHaveBeenCalled();
  });
  it.each([
    `${reply}\nI saved the note.`,
    `I saved the note.\n${reply}`,
    "Saved: a new note.",
    `Saved the note at ${label}.`,
    `${reply} and saved another note.`,
  ])("still rejects unproved write %s", (text) => {
    expect(check(text)).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
  });
  it("preserves successful navigation plus an observed timestamp without rewriting", async () => {
    const navigation: ActionResult = {
      success: true,
      transcriptVisibility: "internal",
      data: {
        actionName: "VIEWS",
        view: { id: "notes", label: "Notes" },
        navigation: {
          effect: "view_navigation",
          status: "delivered",
          viewId: "notes",
          label: "Notes",
          handoffId: "delivery-1",
        },
      },
      values: {
        completedActionDelivered: true,
        viewId: "notes",
        completedActionHandoffId: "delivery-1",
      },
    };
    const text = `Notes is open.\n${reply}`;
    const evaluator = {
      success: true,
      decision: "FINISH" as const,
      replyEffectStatus: "applied" as const,
      messageToUser: text,
    };
    const providers = {
      VIEW_NAVIGATION: {
        data: {
          views: [{ id: "notes", label: "Notes" }],
          currentViewId: "notes",
        },
      },
    };
    expect(
      evaluatePlannedReplyEgress({
        reply: text,
        actionResults: [navigation, read],
        actions: [],
        providers,
        evaluator,
      }),
    ).toEqual({ verdict: "allow" });
    const useModel = vi.fn(async () => {
      throw new Error("No rewrite needed");
    });
    const runtime = createMockRuntime({
      useModel,
      logger: { warn: vi.fn() } as never,
    });
    await expect(
      resolvePlannedReplyEgress({
        runtime,
        message,
        reply: text,
        actionResults: [navigation, read],
        providers,
        evaluator,
      }),
    ).resolves.toEqual({ text, effectReceiptIds: [] });
    const delivered = await enforceEffectGroundedVisibleContent(
      runtime,
      message,
      { text },
      undefined,
      async () => ({
        context: "Current authorized navigation and read",
        actionResults: [navigation, read],
        pendingToolCalls: [],
        evaluatorOutputs: [],
        ownerExclusiveDisclosureUsed: false,
      }),
    );
    expect(delivered.text).toBe(text);
    expect(useModel).not.toHaveBeenCalled();
    expect(runtime.logger.warn).not.toHaveBeenCalled();
    expect(
      evaluatePlannedReplyEgress({
        reply: `${text}\nI saved the note.`,
        actionResults: [navigation, read],
        actions: [],
        providers,
        evaluator,
      }),
    ).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
  });

  it("requires the exact single GET record and its validated host display", () => {
    const exact: ActionResult = {
      ...read,
      data: {
        ...read.data,
        actionName: "NOTES_GET",
        op: "get",
        selection: undefined,
        noteTimestampDisplay: {
          noteId: "note-1",
          timeZone,
          source: "ui",
          createdAt: label,
          updatedAt: label,
        },
      },
    };
    expect(check(reply, [exact])).toEqual({ verdict: "allow" });
    expect(check(reply.replace("Saved:", "Created:"), [exact])).toEqual({
      verdict: "allow",
    });
    expect(check(reply.replace("Saved:", "Updated:"), [exact])).toEqual({
      verdict: "allow",
    });
    expect(
      check(`${reply.replace("Saved:", "Created:")}\nI created a note.`, [
        exact,
      ]),
    ).toEqual({ verdict: "reject", kind: "completed_side_effect" });
    expect(
      check(`${reply.replace("Saved:", "Updated:")}\nI updated the note.`, [
        exact,
      ]),
    ).toEqual({ verdict: "reject", kind: "completed_side_effect" });
    expect(check(reply.replace("Saved:", "Created:"))).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });

    for (const display of [
      {
        noteId: "other-note",
        timeZone,
        source: "ui",
        createdAt: label,
        updatedAt: label,
      },
      {
        noteId: "note-1",
        timeZone: "invalid/zone",
        source: "ui",
        createdAt: label,
        updatedAt: label,
      },
      {
        noteId: "note-1",
        timeZone,
        source: "user-body",
        createdAt: label,
        updatedAt: label,
      },
    ]) {
      expect(
        check(reply, [
          { ...exact, data: { ...exact.data, noteTimestampDisplay: display } },
        ]),
      ).toEqual({ verdict: "reject", kind: "completed_side_effect" });
    }
  });

  it("uses the same host contract for the umbrella Notes read", () => {
    const parent = { ...read, data: { ...read.data, actionName: "NOTES" } };
    expect(check(reply, [parent])).toEqual({ verdict: "allow" });
    expect(
      check(reply, [
        parent,
        { success: true, data: { actionName: "NOTES", op: "patch" } },
      ]),
    ).toEqual({ verdict: "reject", kind: "completed_side_effect" });
  });

  it("does not reuse a superseded earlier read", () => {
    const newerAt = "2026-09-29T03:57:25.000Z";
    const newerLabel = new Intl.DateTimeFormat("en-US", {
      timeZone,
      dateStyle: "medium",
      timeStyle: "long",
    }).format(new Date(newerAt));
    const newer: ActionResult = {
      ...read,
      data: {
        ...read.data,
        notesRevision: 27,
        notes: [{ id: "note-1", createdAt: at, updatedAt: newerAt }],
        selection: {
          kind: "latest",
          field: "updatedAt",
          at: newerAt,
          display: { label: newerLabel, timeZone, source: "explicit" },
        },
      },
    };
    expect(check(reply, [read, newer])).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
    expect(check(reply.replace(label, newerLabel), [read, newer])).toEqual({
      verdict: "allow",
    });
    expect(check(reply, [newer, read])).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
  });

  it("rejects absent, failed, pending, stale or arbitrary metadata", () => {
    const malformed = structuredClone(read);
    if (!malformed.data) throw new Error("Missing fixture data");
    (malformed.data.selection as { display: { label: string } }).display.label =
      "a new note";
    const stale = structuredClone(read);
    if (!stale.data) throw new Error("Missing fixture data");
    (stale.data.notes as Array<{ updatedAt: string }>)[0].updatedAt =
      "2026-09-27T03:57:25.000Z";
    for (const results of [
      [],
      [{ ...read, success: false }],
      [read, { success: false, data: { actionName: "NOTES_PATCH" } }],
      [
        read,
        {
          success: true,
          data: { awaitingDeviceExecution: true, approvalRequired: true },
        },
      ],
      [read, { success: true, values: { awaitingDeviceExecution: true } }],
      [
        {
          success: true,
          data: {
            readOnlyOperation: true,
            notes: [{ body: `Saved: ${label}` }],
          },
        },
      ],
      [malformed],
      [stale],
      [read, { ...read, data: { ...read.data, notesRevision: undefined } }],
      [{ ...read, transcriptVisibility: undefined }],
      [
        read,
        { success: true, data: { actionName: "NOTES_PATCH", op: "update" } },
      ],
    ]) {
      expect(check(reply, results)).toEqual({
        verdict: "reject",
        kind: "completed_side_effect",
      });
    }
    expect(check(reply, [read], true)).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
    expect(check(reply.replace(label, "a different timestamp"))).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
    expect(check("Saved: a new note.", [malformed])).toEqual({
      verdict: "reject",
      kind: "completed_side_effect",
    });
  });
});
