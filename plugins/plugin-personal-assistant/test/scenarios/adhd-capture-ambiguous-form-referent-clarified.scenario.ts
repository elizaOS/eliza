/**
 * A1 adhd-capture-and-start (live). Two open "form" loops are on file — the
 * lease renewal and the insurance reimbursement — so Casey's shorthand "the
 * form thing" is genuinely underdetermined. ADHD capture failure modes cut both
 * ways here: guessing wrong silently moves the wrong deadline, and re-capturing
 * creates a third loop. The assistant must ask one focused clarifier first.
 *
 * The owner turns stay elliptical. API snapshots prove no early mutation and
 * a change to only the selected deadline; the judge assesses clarification tone.
 */
import { isDeepStrictEqual } from "node:util";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readDefinitions(body: unknown): RecordValue[] | string {
  if (!isRecord(body) || !Array.isArray(body.definitions))
    return "Missing definitions readback";
  const definitions = body.definitions.map((row: unknown) =>
    isRecord(row) && isRecord(row.definition) ? row.definition : null,
  );
  if (
    !definitions.every(
      (row): row is RecordValue => row !== null && typeof row.id === "string",
    )
  ) {
    return "Invalid definition in readback";
  }
  return definitions.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function checkRescheduling(ctx: ScenarioContext): string | undefined {
  // Snapshot positions follow the two seeds and the two owner turns below.
  const before = readDefinitions(ctx.turns?.[2]?.responseBody);
  const clarified = readDefinitions(ctx.turns?.[4]?.responseBody);
  const after = readDefinitions(ctx.turns?.[6]?.responseBody);
  if (typeof before === "string") return before;
  if (typeof clarified === "string") return clarified;
  if (typeof after === "string") return after;
  if (!isDeepStrictEqual(before, clarified))
    return "Definitions changed before disambiguation";
  const landlord = before.find(
    (row) => row.title === "Send lease renewal form back to landlord",
  );
  const insurance = before.find(
    (row) =>
      row.title === "Submit insurance reimbursement form for the eye exam",
  );
  if (!landlord || !insurance || landlord.id === insurance.id)
    return "Expected two distinct seeded forms";
  const updated = after.find((row) => row.id === landlord.id);
  if (!updated || after.length !== before.length)
    return "Definition identity or count changed";
  if (
    !isDeepStrictEqual(
      before.filter((row) => row.id !== landlord.id),
      after.filter((row) => row.id !== landlord.id),
    )
  ) {
    return "Unrelated definition changed";
  }
  const cadence = updated.cadence;
  if (
    !isRecord(cadence) ||
    cadence.kind !== "once" ||
    typeof cadence.dueAt !== "string" ||
    updated.timezone !== "UTC"
  ) {
    return "Selected form lost its UTC once cadence";
  }
  const due = new Date(cadence.dueAt);
  const now = Date.parse(ctx.now ?? "");
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(due.getTime()) ||
    due.getTime() <= now ||
    due.getTime() > now + 7 * 86_400_000 ||
    due.getUTCDay() !== 5 ||
    due.getUTCHours() >= 12
  ) {
    return "Selected deadline is not a future Friday morning";
  }
  if (isRecord(landlord.cadence) && landlord.cadence.dueAt === cadence.dueAt)
    return "Selected deadline did not move";
}

// Evening seeds cannot already satisfy the requested morning deadline.
const leaseDue = new Date(Date.now() + 2 * 86_400_000);
leaseDue.setUTCHours(18, 0, 0, 0);

export default scenario({
  lane: "live-only",
  id: "adhd-capture-ambiguous-form-referent-clarified",
  title: "ADHD: an ambiguous 'the form thing' gets a clarifier before any move",
  domain: "lifeops.reminders",
  tags: ["lifeops", "adhd", "personas", "ambiguity", "clarification", "12283"],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "ADHD capture",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-lease-renewal-form",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Send lease renewal form back to landlord",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: leaseDue.toISOString(),
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed-insurance-reimbursement-form",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Submit insurance reimbursement form for the eye exam",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+5d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "before-request",
      method: "GET",
      path: "/api/lifeops/definitions",
      expectedStatus: 200,
    },
    {
      kind: "message",
      name: "casey-refers-to-the-form-thing",
      room: "main",
      text: "brain is soup today. can you shove the form thing to friday morning? i'm not getting to it before that.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Casey has TWO open form obligations on file: the lease renewal form for the landlord, and the insurance reimbursement form for the eye exam. 'the form thing' does not identify one of them. Grade PASS only if the assistant asks one short clarifying question about which form Casey means before rescheduling anything. It fails if it silently picks one, moves both, claims something was already rescheduled, or creates a brand-new form task instead of recognizing the existing ones. A long interrogation or a lecture about being disorganized also fails.",
      },
    },
    {
      kind: "api",
      name: "after-clarifier",
      method: "GET",
      path: "/api/lifeops/definitions",
      expectedStatus: 200,
    },
    {
      kind: "message",
      name: "casey-disambiguates",
      room: "main",
      text: "the landlord one. the eye exam one can sit, it's not urgent.",
    },
    {
      kind: "api",
      name: "after-reschedule",
      method: "GET",
      path: "/api/lifeops/definitions",
      expectedStatus: 200,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "only-the-selected-form-deadline-moved",
      predicate: checkRescheduling,
    },
  ],
});
