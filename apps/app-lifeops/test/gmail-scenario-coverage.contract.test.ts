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
  "gmail.send-with-confirmation",
  "gmail.refuse-send-without-confirmation",
  "gmail.bulk.archive-newsletters",
  "gmail.bulk.report-spam.confirmed",
  "gmail.bulk.too-broad-refused",
] as const;

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

  it("keeps the PRD coverage map in sync with executable Gmail scenarios", async () => {
    const prd = await readFile(GMAIL_PRD_PATH, "utf8");

    for (const id of RELEASE_CRITICAL_SCENARIOS) {
      expect(prd, `${id} must be represented in the Gmail PRD`).toContain(id);
    }
  });
});
