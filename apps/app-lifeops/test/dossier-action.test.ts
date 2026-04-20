/**
 * MOCK-HEAVY UNIT TEST — this file does NOT exercise real dossier generation.
 *
 * Scope verified:
 *   - `dossierAction.validate` returns true when `entityId === agentId`
 *     (the isAgentSelf fast-path in hasAdminAccess) and false for an unknown
 *     entity with no owner record.
 *   - The handler returns `MISSING_SUBJECT` when both `subject` and `intent`
 *     are absent.
 *   - The handler coerces its parameters (`subject`, `calendarEventId`,
 *     `attendeeHandles`) and forwards them to `LifeOpsService#generateDossier`.
 *   - The handler does not swallow errors thrown by `generateDossier`.
 *
 * How the mocking works (LARP caveat):
 *   - `LifeOpsService` is replaced with a stub via `vi.spyOn(...).mockImplementation`,
 *     so `generateDossier` is a `vi.fn()`. This means the real dossier
 *     pipeline (LLM prompting, repository upserts, source aggregation,
 *     attachment handling, etc.) is NEVER executed by this file.
 *   - The assertion "generateDossier was called with { subject, calendarEventId,
 *     attendeeHandles }" only validates the parameter-extraction layer of the
 *     action handler, not whether the downstream service actually uses those
 *     params correctly.
 *
 * Regressions that would slip past this file (add a real-integration test
 * elsewhere with `createLifeOpsTestRuntime` if you care about these):
 *   - `LifeOpsService#generateDossier` silently dropping `attendeeHandles`.
 *   - The dossier persistence path writing a malformed row.
 *   - The LLM prompt contract drifting away from the ActionResult shape.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as serviceModule from "../src/lifeops/service.js";
import { dossierAction } from "../src/actions/dossier.js";

const SAME_ID = "00000000-0000-0000-0000-000000000001";

function makeRuntime() {
  return {
    agentId: SAME_ID,
    getSetting: () => undefined,
    character: { settings: {} },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    },
  } as unknown as Parameters<NonNullable<typeof dossierAction.handler>>[0];
}

function makeMessage(text = "brief me") {
  return {
    entityId: SAME_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text },
  } as unknown as Parameters<NonNullable<typeof dossierAction.handler>>[1];
}

function makeDossier(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString();
  return {
    id: "dossier-1",
    agentId: SAME_ID,
    calendarEventId: null,
    subject: "test",
    generatedForAt: now,
    contentMd: "# Briefing\n\nbody",
    sources: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

let generateDossier: ReturnType<typeof vi.fn>;

beforeEach(() => {
  generateDossier = vi.fn(async () => makeDossier());
  vi.spyOn(serviceModule, "LifeOpsService").mockImplementation(
    function (this: Record<string, unknown>) {
      this.generateDossier = generateDossier;
    } as unknown as typeof serviceModule.LifeOpsService,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dossierAction validate", () => {
  test("allows agent self (entityId === agentId)", async () => {
    const ok = await dossierAction.validate!(makeRuntime(), makeMessage());
    expect(ok).toBe(true);
  });

  test("denies non-owner non-admin entity", async () => {
    const otherMsg = {
      entityId: "00000000-0000-0000-0000-0000000000ff",
      roomId: "00000000-0000-0000-0000-000000000002",
      content: { text: "" },
    } as unknown as Parameters<NonNullable<typeof dossierAction.validate>>[1];
    const ok = await dossierAction.validate!(makeRuntime(), otherMsg);
    expect(ok).toBe(false);
  });
});

describe("dossierAction handler", () => {
  test("rejects with MISSING_SUBJECT when subject and intent both missing", async () => {
    const result = await dossierAction.handler!(
      makeRuntime(),
      makeMessage(""),
      undefined,
      { parameters: {} },
    );
    const r = result as {
      success: boolean;
      values?: { error?: string };
    };
    expect(r.success).toBe(false);
    expect(r.values?.error).toBe("MISSING_SUBJECT");
    expect(generateDossier).not.toHaveBeenCalled();
  });

  test("calls service.generateDossier with extracted params and returns success on resolve", async () => {
    const result = await dossierAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          subject: "2pm with Alice",
          calendarEventId: "evt-42",
          attendeeHandles: ["alice@example.com", "bob@example.com"],
        },
      },
    );

    expect(generateDossier).toHaveBeenCalledTimes(1);
    const call = generateDossier.mock.calls[0][0] as Record<string, unknown>;
    expect(call.subject).toBe("2pm with Alice");
    expect(call.calendarEventId).toBe("evt-42");
    expect(call.attendeeHandles).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);

    const r = result as {
      success: boolean;
      data?: { dossier?: { id?: string } };
    };
    expect(r.success).toBe(true);
    expect(r.data?.dossier?.id).toBe("dossier-1");
  });

  test("propagates service errors (does not swallow)", async () => {
    generateDossier.mockRejectedValueOnce(new Error("downstream boom"));
    await expect(
      dossierAction.handler!(
        makeRuntime(),
        makeMessage(),
        undefined,
        { parameters: { subject: "topic" } },
      ),
    ).rejects.toThrow("downstream boom");
  });
});
