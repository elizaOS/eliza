/**
 * Calendar update extraction conformance. A provider that accepts the
 * structured update request and returns `{}` (seen on a phone: two completion
 * tokens for "move the check to 4pm") must not read as "no change requested".
 * The shared calendar JSON runner retries a nonconforming record once; a second
 * nonconforming record is an explicit extraction failure and nothing changes.
 * Only a non-object or a record with no declared field holding a value is
 * nonconforming: null and loosely typed values in declared fields read exactly
 * as they did before the check. A model call that returns nothing is a
 * provider failure, reported without asking the owner to rephrase.
 * Synthetic model output only; nothing is saved.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  inferSelectedCalendarUpdate,
  registerCalendarActionHostAdapter,
} from "../src/actions/calendar-handler.ts";
import { calendarExtractionSchemaViolations } from "../src/actions/extraction-conformance.ts";

type HostAdapter = Parameters<typeof registerCalendarActionHostAdapter>[1];
type JsonResult = {
  rawResponse: string;
  parsed: Record<string, unknown>;
} | null;

const json = (parsed: Record<string, unknown>): JsonResult => ({
  rawResponse: JSON.stringify(parsed),
  parsed,
});

const fields = {
  title: "Check",
  description: "",
  location: "",
  start: "2026-11-21T19:00:00.000Z",
  end: "2026-11-21T19:30:00.000Z",
  timeZone: "America/Los_Angeles",
};

/** A complete, schema-conforming update extraction moving the event to 4pm. */
const moveToFour = {
  requiresInput: false,
  clarification: null,
  title: null,
  description: null,
  location: null,
  startAt: "2026-11-21T16:00:00",
  endAt: null,
  allDayStartDate: null,
  allDayEndDate: null,
  timeZone: null,
  recurrence: null,
  recurrenceScope: null,
  clearFields: [],
  addGuests: [],
  removeGuests: [],
};

function runtimeWith(...responses: JsonResult[]) {
  const reportError = vi.fn();
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    getService: () => null,
    reportError,
  } as unknown as IAgentRuntime;
  const runJsonModel = vi.fn(async () => {
    if (responses.length === 0) throw new Error("unexpected extra model call");
    return responses.shift() ?? null;
  });
  registerCalendarActionHostAdapter(runtime, {
    runJsonModel: runJsonModel as unknown as HostAdapter["runJsonModel"],
    recentConversationTexts: async () => [],
  });
  return { runtime, reportError, runJsonModel };
}

const infer = (runtime: IAgentRuntime) =>
  inferSelectedCalendarUpdate({
    runtime,
    message: {
      id: "00000000-0000-4000-8000-000000000451",
      entityId: "00000000-0000-4000-8000-000000000102",
      roomId: "00000000-0000-4000-8000-000000000103",
      createdAt: Date.parse("2026-11-21T17:00:00.000Z"),
      content: { text: "move the check to 4pm" },
    } as Memory,
    fields,
    timeZone: "America/Los_Angeles",
    signal: new AbortController().signal,
  });

describe("calendar update extraction conformance", () => {
  it("retries an empty extraction once and applies the conforming retry", async () => {
    const { runtime, reportError, runJsonModel } = runtimeWith(
      json({}),
      json(moveToFour),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toMatchObject({
      start: "2026-11-22T00:00:00.000Z",
      end: "2026-11-22T00:30:00.000Z",
    });
    expect(draft.text).toContain("ready for update review");
    expect(runJsonModel).toHaveBeenCalledTimes(2);
    const retryArgs = runJsonModel.mock.calls[1] as unknown as [
      { prompt: string },
    ];
    expect(retryArgs[0].prompt).toContain(
      "none of the schema fields were returned",
    );
    expect(retryArgs[0].prompt).toContain(
      "return requiresInput:true with a clarification",
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports an explicit extraction failure, without a change, after two empty extractions", async () => {
    const { runtime, reportError, runJsonModel } = runtimeWith(
      json({}),
      json({}),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toBe(
      "The requested change could not be read from your request. Nothing was changed. Say the change again.",
    );
    expect(draft.text).not.toContain("No requested field change");
    expect(reportError).toHaveBeenCalledWith(
      "calendar:native-update",
      expect.objectContaining({ code: "CALENDAR_UPDATE_EXTRACTION_INVALID" }),
      { diagnosticOnly: true, code: "CALENDAR_UPDATE_EXTRACTION_INVALID" },
    );
    expect(runJsonModel).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "null guest and clear-field arrays",
      record: {
        ...moveToFour,
        clearFields: null,
        addGuests: null,
        removeGuests: null,
      },
    },
    {
      name: "omitted optional fields",
      record: { requiresInput: false, startAt: "2026-11-21T16:00:00" },
    },
    {
      name: "an undeclared key next to declared fields",
      record: { ...moveToFour, note: "moved" },
    },
  ])(
    "applies a move whose extraction has $name on the first call",
    async ({ record }) => {
      const { runtime, reportError, runJsonModel } = runtimeWith(json(record));
      const draft = await infer(runtime);
      expect(draft.fields).toMatchObject({
        start: "2026-11-22T00:00:00.000Z",
        end: "2026-11-22T00:30:00.000Z",
      });
      expect(draft.text).toContain("ready for update review");
      expect(runJsonModel).toHaveBeenCalledTimes(1);
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it("keeps the pre-check reading of a null requiresInput on the device path", async () => {
    // The device contract applies only requiresInput:false; a null flag was
    // and remains a request for an exact review, decided in one model call.
    const { runtime, runJsonModel } = runtimeWith(
      json({ ...moveToFour, requiresInput: null }),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toBe(
      "The event was shared, but those requested changes need a supported exact review. Nothing was changed.",
    );
    expect(runJsonModel).toHaveBeenCalledTimes(1);
  });

  it("treats an all-null record as empty and retries it", async () => {
    const allNull = Object.fromEntries(
      Object.keys(moveToFour).map((key) => [key, null]),
    );
    const { runtime, runJsonModel } = runtimeWith(
      json(allNull),
      json(moveToFour),
    );
    const draft = await infer(runtime);
    expect(draft.fields).toMatchObject({ start: "2026-11-22T00:00:00.000Z" });
    expect(runJsonModel).toHaveBeenCalledTimes(2);
  });

  it("reports a model call that returns nothing as a provider failure without rephrase coaching", async () => {
    const { runtime, reportError, runJsonModel } = runtimeWith(null);
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toBe(
      "The calendar model did not respond, so the requested change was not read. No event was changed. This is a service problem, not a problem with the request.",
    );
    expect(draft.text).not.toContain("Say the change again");
    expect(reportError).toHaveBeenCalledWith(
      "calendar:native-update",
      expect.objectContaining({
        code: "CALENDAR_EXTRACTION_MODEL_UNAVAILABLE",
      }),
      { code: "CALENDAR_EXTRACTION_MODEL_UNAVAILABLE" },
    );
    // Nothing was read, so there is no nonconforming record to retry.
    expect(runJsonModel).toHaveBeenCalledTimes(1);
  });

  it("reports a provider failure on the retry the same way", async () => {
    const { runtime, runJsonModel } = runtimeWith(json({}), null);
    const draft = await infer(runtime);
    expect(draft.fields).toBeUndefined();
    expect(draft.text).toContain("The calendar model did not respond");
    expect(runJsonModel).toHaveBeenCalledTimes(2);
  });

  it("does not retry a conforming extraction", async () => {
    const { runtime, runJsonModel } = runtimeWith(json(moveToFour));
    const draft = await infer(runtime);
    expect(draft.fields).toMatchObject({ start: "2026-11-22T00:00:00.000Z" });
    expect(runJsonModel).toHaveBeenCalledTimes(1);
  });
});

describe("calendarExtractionSchemaViolations", () => {
  const schema = {
    type: "object",
    properties: {
      requiresInput: { type: "boolean" },
      startAt: { type: ["string", "null"] },
      clearFields: { type: "array", items: { type: "string" } },
    },
    required: ["requiresInput", "startAt", "clearFields"],
    additionalProperties: false,
  } as const;

  const none =
    "none of the schema fields were returned (required: requiresInput, startAt, clearFields)";

  it("accepts any record with one declared field holding a value", () => {
    expect(
      calendarExtractionSchemaViolations(schema, {
        requiresInput: false,
        startAt: null,
        clearFields: [],
      }),
    ).toEqual([]);
    // Omitted and null declared fields keep their existing consumer readings.
    expect(
      calendarExtractionSchemaViolations(schema, {
        startAt: "2026-11-21T16:00:00",
        requiresInput: null,
        clearFields: null,
      }),
    ).toEqual([]);
    // Value types are the consumer's to coerce or ignore, as before the check.
    expect(
      calendarExtractionSchemaViolations(schema, {
        requiresInput: "false",
        startAt: 16,
      }),
    ).toEqual([]);
  });

  it("rejects a non-object and a record with no declared field holding a value", () => {
    expect(calendarExtractionSchemaViolations(schema, {})).toEqual([none]);
    expect(
      calendarExtractionSchemaViolations(schema, { note: "moved" }),
    ).toEqual([none]);
    expect(
      calendarExtractionSchemaViolations(schema, {
        requiresInput: null,
        startAt: null,
        clearFields: null,
      }),
    ).toEqual([none]);
    expect(calendarExtractionSchemaViolations(schema, null)).toEqual([
      "the response is not a JSON object",
    ]);
    expect(calendarExtractionSchemaViolations(schema, [moveToFour])).toEqual([
      "the response is not a JSON object",
    ]);
  });
});
