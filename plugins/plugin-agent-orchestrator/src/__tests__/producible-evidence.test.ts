/**
 * Contract tests for the producible-evidence module (#20794): backend
 * capability resolution fails closed, invented-artifact criteria are dropped
 * while goal-named paths survive, and the deterministic ledger verdict
 * promotes only when EVERY criterion is satisfied by concrete facts — with
 * the live-incident shapes (invented `agent-home/canon-clock.html` path,
 * served-URL + ledger-write quick-app) pinned. Deterministic; no model, IO,
 * or environment mutation beyond scoped env stubs.
 */

import { afterEach, describe, expect, test } from "vitest";
import { generateDefaultAcceptanceCriteria } from "../services/acceptance-criteria.js";
import {
  capabilitiesForBackend,
  deterministicLedgerVerdict,
  isGreenCheckOutput,
  isPubliclyReachableUrl,
  renderDeterministicVerdict,
  stripInventedArtifactCriteria,
} from "../services/producible-evidence.js";

const ENV_KEYS = [
  "ELIZA_ENVELOPE_CAPABLE_BACKENDS",
  "ELIZA_SANDBOX_HAS_BROWSER",
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("capabilitiesForBackend", () => {
  test("elizaos brain has no envelope; claude/codex do; unknown fails closed", () => {
    expect(capabilitiesForBackend("eliza-code").completionEnvelope).toBe(false);
    expect(capabilitiesForBackend("elizaos").completionEnvelope).toBe(false);
    expect(capabilitiesForBackend("claude").completionEnvelope).toBe(true);
    expect(capabilitiesForBackend("claude-code").completionEnvelope).toBe(true);
    expect(capabilitiesForBackend("codex").completionEnvelope).toBe(true);
    expect(capabilitiesForBackend(undefined).completionEnvelope).toBe(false);
    expect(capabilitiesForBackend("").completionEnvelope).toBe(false);
  });

  test("sandboxes are headless unless explicitly declared otherwise", () => {
    expect(capabilitiesForBackend("claude").browser).toBe(false);
    process.env.ELIZA_SANDBOX_HAS_BROWSER = "1";
    expect(capabilitiesForBackend("claude").browser).toBe(true);
  });

  test("deployments can override the envelope-capable list", () => {
    process.env.ELIZA_ENVELOPE_CAPABLE_BACKENDS = "eliza-code";
    expect(capabilitiesForBackend("eliza-code").completionEnvelope).toBe(true);
    expect(capabilitiesForBackend("claude").completionEnvelope).toBe(false);
  });
});

describe("stripInventedArtifactCriteria", () => {
  test("drops the live-incident invented path and keeps outcome criteria", () => {
    const goal =
      "build a one-file canon clock page in the shared route workdir";
    const { kept, dropped } = stripInventedArtifactCriteria(
      [
        "Diff confirms the creation of `agent-home/canon-clock.html`",
        "the live URL returns HTTP 200",
        "typecheck passes",
      ],
      goal,
    );
    expect(dropped).toEqual([
      "Diff confirms the creation of `agent-home/canon-clock.html`",
    ]);
    expect(kept).toEqual(["the live URL returns HTTP 200", "typecheck passes"]);
  });

  test("a path the goal itself names survives", () => {
    const goal = "create data/apps/clock/index.html with a live clock";
    const { kept, dropped } = stripInventedArtifactCriteria(
      ["the file data/apps/clock/index.html exists and serves"],
      goal,
    );
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  test("prose tokens like e.g. and version numbers are not artifact claims", () => {
    const { dropped } = stripInventedArtifactCriteria(
      ["tests pass (e.g. unit and integration, v1.2 compatible)"],
      "fix the flaky scheduler",
    );
    expect(dropped).toEqual([]);
  });
});

describe("deterministicLedgerVerdict", () => {
  const quickAppFacts = {
    verifiedPublicUrls: ["https://nubilio.org/apps/canon-clock/"],
    ledgerVerifiedFiles: ["data/apps/canon-clock/index.html"],
    hasChangeSet: true,
    greenChecks: { test: false, build: false, lint: false },
  };

  test("the live quick-app incident shape passes deterministically", () => {
    const verdict = deterministicLedgerVerdict(
      [
        "the deployed app is reachable at its public URL",
        "the deliverable file exists in the workdir",
        "the change is summarized in the diff",
      ],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(true);
    expect(verdict.met).toHaveLength(3);
    expect(verdict.results[0]?.basis).toContain("nubilio.org");
    expect(verdict.results[1]?.basis).toContain("canon-clock/index.html");
  });

  test("an unsatisfied check criterion stays undetermined and blocks allMet", () => {
    const verdict = deterministicLedgerVerdict(
      ["the deployed app is reachable at its public URL", "tests pass"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(false);
    expect(verdict.undetermined).toEqual(["tests pass"]);
  });

  test("behavioral URL criteria stay undetermined on reachability alone (#21002)", () => {
    // A probe answering cannot prove HTTP status, auth, error, content, or
    // method behavior — so each of these must NOT auto-pass from a verified
    // URL, even when the criterion contains URL/API vocabulary.
    const behavioral = [
      "the API returns 401 for an invalid token",
      "the endpoint responds with HTTP 200",
      "the deployed URL requires authentication",
      "a GET request to the endpoint returns JSON",
      "the API rejects a malformed request body with an error",
    ];
    for (const criterion of behavioral) {
      const verdict = deterministicLedgerVerdict([criterion], quickAppFacts);
      expect(verdict.allMet).toBe(false);
      expect(verdict.undetermined).toEqual([criterion]);
      expect(verdict.results[0]?.basis).toBeUndefined();
    }
  });

  test("a named+verified URL still cannot prove behavior (#21002)", () => {
    // Even when the exact probed URL is named, reachability does not prove the
    // asserted 401 response — the criterion must defer to model judgment.
    const verdict = deterministicLedgerVerdict(
      [
        "https://nubilio.org/apps/canon-clock/ returns HTTP 401 for a bad token",
      ],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(false);
    expect(verdict.undetermined).toHaveLength(1);
  });

  test("a plain reachability criterion still passes with any verified URL (#21002)", () => {
    const verdict = deterministicLedgerVerdict(
      ["the deployed app is reachable and serves at a public URL"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(true);
    expect(verdict.results[0]?.basis).toContain("nubilio.org");
  });

  test("green mined output satisfies test/build/lint criteria", () => {
    const verdict = deterministicLedgerVerdict(
      ["tests pass", "typecheck passes", "lint passes"],
      {
        ...quickAppFacts,
        greenChecks: { test: true, build: true, lint: true },
      },
    );
    expect(verdict.allMet).toBe(true);
  });

  test("screenshot criteria are never deterministically met", () => {
    const verdict = deterministicLedgerVerdict(
      ["a screenshot of the working view is attached"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(false);
  });

  test("a criterion naming a specific file must match the ledger", () => {
    const verdict = deterministicLedgerVerdict(
      ["the file other/place.html is created"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(false);
  });

  test("an unrelated verified URL does not satisfy a demanded explicit URL", () => {
    // The demanded URL was never probed; a different verified URL must not
    // stand in for it even for a plain reachability assertion (#21002).
    const verdict = deterministicLedgerVerdict(
      ["https://nubilio.org/apps/other/ is reachable"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(false);
    expect(verdict.undetermined).toEqual([
      "https://nubilio.org/apps/other/ is reachable",
    ]);
  });

  test("empty criteria never auto-pass", () => {
    expect(deterministicLedgerVerdict([], quickAppFacts).allMet).toBe(false);
  });

  test("renders met bases and undetermined markers", () => {
    const rendered = renderDeterministicVerdict(
      deterministicLedgerVerdict(
        ["the deployed app is reachable at its public URL", "tests pass"],
        quickAppFacts,
      ),
    );
    expect(rendered).toContain(
      "MET: the deployed app is reachable at its public URL",
    );
    expect(rendered).toContain("undetermined (needs judgment): tests pass");
  });
});

describe("public URL evidence", () => {
  test.each([
    "file:///etc/passwd",
    "ssh://example.com/repo",
    "http://localhost:3000",
    "http://app.local",
    "http://127.9.8.7",
    "http://10.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://[fd00::1]",
  ])("rejects non-public target %s", (url) => {
    expect(isPubliclyReachableUrl(url)).toBe(false);
  });

  test("accepts a public HTTP(S) target", () => {
    expect(isPubliclyReachableUrl("https://nubilio.org/apps/clock/")).toBe(
      true,
    );
  });
});

describe("green check output", () => {
  test.each([
    "Failed: 1, Passed: 10",
    "not ok 3 - integration",
    "PASS\nERROR: teardown",
  ])("rejects red output even when it also has green markers: %s", (output) => {
    expect(isGreenCheckOutput(output)).toBe(false);
  });

  test("accepts an explicit zero-failure summary", () => {
    expect(isGreenCheckOutput("12 passed, 0 failed")).toBe(true);
  });
});

describe("generateDefaultAcceptanceCriteria enforcement (#20794)", () => {
  test("model-refined criteria pinning invented paths are dropped and topped up", async () => {
    const goal =
      "build a one-file canon clock page in the shared route workdir";
    const useModel = async () =>
      JSON.stringify({
        criteria: [
          "Diff confirms the creation of `agent-home/canon-clock.html`",
          "the live URL returns HTTP 200",
          "the page shows a ticking clock",
        ],
      });
    const criteria = await generateDefaultAcceptanceCriteria(goal, undefined, {
      useModel,
    } as never);
    expect(criteria.join("\n")).not.toContain("agent-home/canon-clock.html");
    expect(criteria).toContain("the live URL returns HTTP 200");
    expect(criteria.length).toBeGreaterThanOrEqual(3);
  });
});
