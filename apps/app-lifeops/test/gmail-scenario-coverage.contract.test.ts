import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@elizaos/scenario-schema",
  () => ({
    scenario: <T>(value: T) => value,
  }),
  { virtual: true },
);

type ScenarioFinalCheck = {
  type?: string;
  expected?: boolean;
  state?: string;
  operation?: string | string[];
  method?: string | string[];
  path?: string | string[];
  subaction?: string | string[];
  body?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
};

type ScenarioTurn = {
  text?: string;
  responseJudge?: { rubric: string; minimumScore?: number };
  responseIncludesAny?: unknown;
  responseMatches?: unknown;
  [key: string]: unknown;
};

type GmailScenario = {
  id: string;
  domain: string;
  tags?: string[];
  requires?: {
    credentials?: string[];
    plugins?: string[];
  };
  seed?: Array<Record<string, unknown>>;
  turns: ScenarioTurn[];
  finalChecks?: ScenarioFinalCheck[];
  cleanup?: Array<Record<string, unknown>>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const GMAIL_SCENARIO_DIR = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "messaging.gmail",
);
const GMAIL_PRD_PATH = path.join(
  REPO_ROOT,
  "docs",
  "plans",
  "2026-04-22-gmail-lifeops-integration-review.md",
);

const RELEASE_CRITICAL_SCENARIOS = [
  "gmail.triage.unread",
  "gmail.triage.high-priority-client",
  "gmail.recommend.inbox-zero-plan",
  "gmail.search.spam-trash",
  "gmail.unresponded.sent-no-reply",
  "gmail.draft.reply-from-context",
  "gmail.draft.followup-14-days",
  "gmail.draft.no-silent-fallback",
  "gmail.send-with-confirmation",
  "gmail.send.stale-confirmation-refused",
  "gmail.refuse-send-without-confirmation",
  "gmail.bulk.archive-newsletters",
  "gmail.bulk.report-spam.confirmed",
  "gmail.bulk.apply-label.name-resolution",
  "gmail.bulk.too-broad-refused",
] as const;

const DYNAMIC_TARGET_SCENARIOS = new Set([
  "gmail.bulk.archive-newsletters",
  "gmail.bulk.report-spam.confirmed",
  "gmail.bulk.apply-label.name-resolution",
  "gmail.draft.reply-from-context",
  "gmail.draft.followup-14-days",
  "gmail.send-with-confirmation",
  "gmail.send.stale-confirmation-refused",
]);

const GMAIL_PROOF_TYPES = new Set([
  "gmailActionArguments",
  "gmailMockRequest",
  "gmailDraftCreated",
  "gmailDraftDeleted",
  "gmailMessageSent",
  "gmailBatchModify",
  "gmailApproval",
  "gmailNoRealWrite",
  "n8nDispatchOccurred",
]);

function hasPositiveCheck(
  scenario: GmailScenario,
  type: string,
): boolean {
  return (scenario.finalChecks ?? []).some(
    (check) => check.type === type && check.expected !== false,
  );
}

function findScenario(
  scenarios: Array<{ scenario: GmailScenario }>,
  id: string,
): GmailScenario {
  const found = scenarios.find(({ scenario }) => scenario.id === id)?.scenario;
  expect(found, `${id} must exist`).toBeDefined();
  return found as GmailScenario;
}

async function loadScenarioFile(file: string): Promise<GmailScenario> {
  const module = await import(pathToFileURL(file).href);
  return module.default as GmailScenario;
}

async function loadGmailScenarios(): Promise<
  Array<{ file: string; source: string; scenario: GmailScenario }>
> {
  const entries = (await readdir(GMAIL_SCENARIO_DIR))
    .filter((entry) => entry.endsWith(".scenario.ts"))
    .sort();
  return Promise.all(
    entries.map(async (entry) => {
      const file = path.join(GMAIL_SCENARIO_DIR, entry);
      const [source, scenario] = await Promise.all([
        readFile(file, "utf8"),
        loadScenarioFile(file),
      ]);
      return { file, source, scenario };
    }),
  );
}

function hasSemanticJudge(scenario: GmailScenario): boolean {
  return (
    scenario.turns.some((turn) => turn.responseJudge !== undefined) ||
    (scenario.finalChecks ?? []).some((check) => check.type === "judgeRubric")
  );
}

function hasGmailProof(scenario: GmailScenario): boolean {
  return (scenario.finalChecks ?? []).some((check) =>
    GMAIL_PROOF_TYPES.has(String(check.type ?? "")),
  );
}

function operationsFor(scenario: GmailScenario): string[] {
  return (scenario.finalChecks ?? []).flatMap((check) => {
    if (check.type !== "gmailActionArguments") {
      return [];
    }
    const operation = check.operation;
    if (Array.isArray(operation)) {
      return operation;
    }
    return typeof operation === "string" ? [operation] : [];
  });
}

function finalChecksContain(
  scenario: GmailScenario,
  predicate: (check: ScenarioFinalCheck) => boolean,
): boolean {
  return (scenario.finalChecks ?? []).some(predicate);
}

function hasActionCheckWithSubaction(
  scenario: GmailScenario,
  subaction: string | string[],
): boolean {
  const accepted = Array.isArray(subaction) ? subaction : [subaction];
  return finalChecksContain(
    scenario,
    (check) =>
      check.type === "gmailActionArguments" &&
      accepted.some((candidate) => {
        const actual = check.subaction;
        return Array.isArray(actual)
          ? actual.includes(candidate)
          : actual === candidate;
      }),
  );
}

function hasMockRequest(
  scenario: GmailScenario,
  method: string,
  requestPath: string,
  expected = true,
): boolean {
  return finalChecksContain(
    scenario,
    (check) =>
      check.type === "gmailMockRequest" &&
      check.method === method &&
      check.path === requestPath &&
      (check.expected ?? true) === expected,
  );
}

function hasBatchModifyBodyField(
  scenario: GmailScenario,
  field: string,
  expectedValue: string,
): boolean {
  return finalChecksContain(
    scenario,
    (check) =>
      check.type === "gmailBatchModify" &&
      check.body?.[field] === expectedValue,
  );
}

function containsFixtureId(value: unknown): boolean {
  if (typeof value === "string") {
    return value
      .split(/[^A-Za-z0-9-]+/)
      .some((token) => token.startsWith("msg-") || token.startsWith("thr-"));
  }
  if (Array.isArray(value)) {
    return value.some(containsFixtureId);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(containsFixtureId);
  }
  return false;
}

describe("Gmail scenario coverage contract", () => {
  it("covers release-critical Gmail personal-assistant UX paths", async () => {
    const scenarios = await loadGmailScenarios();
    const ids = scenarios.map(({ scenario }) => scenario.id).sort();

    expect(ids).toEqual(expect.arrayContaining([...RELEASE_CRITICAL_SCENARIOS]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requires structured Gmail proof, LLM semantic judges, and no-real-write checks", async () => {
    const scenarios = await loadGmailScenarios();

    for (const { source, scenario } of scenarios) {
      expect(scenario.domain, scenario.id).toBe("messaging.gmail");
      expect(
        scenario.requires?.credentials ?? [],
        `${scenario.id} must require the Gmail test owner credential`,
      ).toContain("gmail:test-owner");
      expect(
        hasGmailProof(scenario),
        `${scenario.id} must include structured Gmail final checks`,
      ).toBe(true);
      expect(
        hasSemanticJudge(scenario),
        `${scenario.id} must include a responseJudge or judgeRubric`,
      ).toBe(true);
      expect(
        (scenario.finalChecks ?? []).some(
          (check) => check.type === "gmailNoRealWrite",
        ),
        `${scenario.id} must prove it cannot write to real Gmail`,
      ).toBe(true);
      expect(source, `${scenario.id} must not use response text includes`).not
        .toContain("responseIncludesAny");
      expect(source, `${scenario.id} must not use response regex matches`).not
        .toContain("responseMatches");
      expect(source, `${scenario.id} must not use helper substring assertions`).not
        .toContain("expectTurnToCallAction");
      expect(source, `${scenario.id} must not use per-turn helper assertions`).not
        .toContain("assertTurn");
      expect(source, `${scenario.id} must not use action blob includesAny`).not
        .toContain("includesAny");
      expect(source, `${scenario.id} must not use action blob includesAll`).not
        .toContain("includesAll");
      expect(
        containsFixtureId(scenario.finalChecks ?? []),
        `${scenario.id} final checks must not hardcode Gmail fixture message/thread IDs`,
      ).toBe(false);
    }
  });

  it("keeps Gmail writes bounded by approvals, mocks, and precise operations", async () => {
    const scenarios = await loadGmailScenarios();

    for (const { source, scenario } of scenarios) {
      const tags = scenario.tags ?? [];
      const operations = operationsFor(scenario);
      const hasSend = hasPositiveCheck(scenario, "gmailMessageSent");
      const hasBatchWrite = hasPositiveCheck(scenario, "gmailBatchModify");

      if (hasSend) {
        expect(
          (scenario.finalChecks ?? []).some(
            (check) =>
              check.type === "gmailApproval" && check.state === "confirmed",
          ),
          `${scenario.id} sends Gmail but does not prove confirmed approval`,
        ).toBe(true);
      }

      if (hasBatchWrite) {
        expect(
          operations.length,
          `${scenario.id} writes Gmail but does not assert the manage operation`,
        ).toBeGreaterThan(0);
        expect(
          (scenario.finalChecks ?? []).some(
            (check) => check.type === "gmailNoRealWrite",
          ),
          `${scenario.id} writes Gmail without no-real-write proof`,
        ).toBe(true);
      }

      if (operations.some((operation) => operation === "report_spam")) {
        expect(
          source,
          `${scenario.id} reports spam without an explicit destructive confirmation turn`,
        ).toContain("confirm this destructive Gmail action");
      }

      if (tags.includes("read-only") || tags.includes("negative")) {
        expect(
          hasBatchWrite,
          `${scenario.id} is read-only/negative but expects Gmail batch writes`,
        ).toBe(false);
        expect(
          hasSend,
          `${scenario.id} is read-only/negative but expects Gmail sends`,
        ).toBe(false);
      }
    }
  });

  it("proves stepwise target discovery without hardcoded Gmail targets", async () => {
    const scenarios = await loadGmailScenarios();

    for (const id of DYNAMIC_TARGET_SCENARIOS) {
      const scenario = findScenario(scenarios, id);
      const hasActionDiscovery = hasActionCheckWithSubaction(scenario, [
        "search",
        "read",
        "unresponded",
      ]);
      const hasLedgerDiscovery =
        hasMockRequest(scenario, "GET", "/gmail/v1/users/me/messages") ||
        hasMockRequest(scenario, "GET", "/gmail/v1/users/me/threads");

      expect(
        hasActionDiscovery || hasLedgerDiscovery,
        `${id} must prove the assistant discovered the Gmail target before acting`,
      ).toBe(true);
    }
  });

  it("covers confirmation bound to selected Gmail messages and stale consent refusal", async () => {
    const scenarios = await loadGmailScenarios();
    const confirmedSend = findScenario(scenarios, "gmail.send-with-confirmation");
    const confirmedSpam = findScenario(
      scenarios,
      "gmail.bulk.report-spam.confirmed",
    );
    const staleSend = findScenario(
      scenarios,
      "gmail.send.stale-confirmation-refused",
    );

    expect(hasPositiveCheck(confirmedSend, "gmailDraftCreated")).toBe(true);
    expect(
      finalChecksContain(
        confirmedSend,
        (check) => check.type === "gmailApproval" && check.state === "pending",
      ),
    ).toBe(true);
    expect(
      finalChecksContain(
        confirmedSend,
        (check) => check.type === "gmailApproval" && check.state === "confirmed",
      ),
    ).toBe(true);

    expect(operationsFor(confirmedSpam)).toContain("report_spam");
    expect(
      finalChecksContain(
        confirmedSpam,
        (check) =>
          check.type === "gmailActionArguments" &&
          check.operation === "report_spam" &&
          check.fields?.confirmDestructive === true,
      ),
    ).toBe(true);

    expect(hasPositiveCheck(staleSend, "gmailDraftCreated")).toBe(true);
    expect(
      finalChecksContain(
        staleSend,
        (check) => check.type === "gmailApproval" && check.state === "pending",
      ),
    ).toBe(true);
    expect(hasPositiveCheck(staleSend, "gmailMessageSent")).toBe(false);
    expect(
      hasMockRequest(
        staleSend,
        "POST",
        "/gmail/v1/users/me/messages/send",
        false,
      ),
    ).toBe(true);
  });

  it("covers Gmail label-name resolution and no silent draft fallback", async () => {
    const scenarios = await loadGmailScenarios();
    const labelScenario = findScenario(
      scenarios,
      "gmail.bulk.apply-label.name-resolution",
    );
    const noFallbackScenario = findScenario(
      scenarios,
      "gmail.draft.no-silent-fallback",
    );

    expect(hasMockRequest(labelScenario, "GET", "/gmail/v1/users/me/labels")).toBe(
      true,
    );
    expect(operationsFor(labelScenario)).toContain("apply_label");
    expect(hasBatchModifyBodyField(labelScenario, "addLabelIds", "Label_1")).toBe(
      true,
    );

    expect(hasPositiveCheck(noFallbackScenario, "gmailDraftCreated")).toBe(false);
    expect(hasPositiveCheck(noFallbackScenario, "gmailMessageSent")).toBe(false);
    expect(
      hasMockRequest(noFallbackScenario, "POST", "/gmail/v1/users/me/drafts", false),
    ).toBe(true);
    expect(
      hasMockRequest(
        noFallbackScenario,
        "POST",
        "/gmail/v1/users/me/messages/send",
        false,
      ),
    ).toBe(true);
  });

  it("keeps the PRD coverage map in sync with executable Gmail scenarios", async () => {
    const prd = await readFile(GMAIL_PRD_PATH, "utf8");

    for (const id of RELEASE_CRITICAL_SCENARIOS) {
      expect(prd, `${id} must be represented in the Gmail PRD`).toContain(id);
    }
  });
});
