/**
 * Exercises deterministic goal-verifier evidence classification without a
 * model or external I/O. The suite ensures only concrete, matching facts can
 * promote a criterion while ambiguous claims fail closed.
 */

import { afterEach, describe, expect, test } from "vitest";
import { generateDefaultAcceptanceCriteria } from "../services/acceptance-criteria.js";
import {
  capabilitiesForBackend,
  deterministicLedgerVerdict,
  isCompletedToolEvidence,
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
        "the live URL is reachable",
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
    // A code file in the deliverable makes the check APPLICABLE — the
    // static-only vacuous leg (see the dedicated describe) must not fire.
    const verdict = deterministicLedgerVerdict(
      ["the live URL is reachable", "tests pass"],
      {
        ...quickAppFacts,
        ledgerVerifiedFiles: [
          ...quickAppFacts.ledgerVerifiedFiles,
          "data/apps/canon-clock/main.ts",
        ],
      },
    );
    expect(verdict.allMet).toBe(false);
    expect(verdict.undetermined).toEqual(["tests pass"]);
  });

  test("does not promote behavioral or composite criteria from unrelated facts", () => {
    const verdict = deterministicLedgerVerdict(
      [
        "the live URL renders the expected clock content",
        "add tests covering the retry race",
        "build a page showing the clock",
        "the deliverable file exists and contains the requested animation",
      ],
      {
        ...quickAppFacts,
        greenChecks: { test: true, build: true, lint: true },
      },
    );
    expect(verdict.allMet).toBe(false);
    expect(verdict.met).toEqual([]);
    expect(verdict.undetermined).toHaveLength(4);
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

  test("a criterion naming a specific URL must match the probed URL", () => {
    const verdict = deterministicLedgerVerdict(
      ["https://nubilio.org/apps/other/ returns HTTP 200"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(false);
  });

  test.each([
    "the API returns 401 for an invalid token",
    "the endpoint requires authentication",
    "the live URL returns HTTP 200",
    "the response body contains the deployed version",
    "POST /v1/jobs rejects an invalid payload",
  ])(
    "reachability alone does not satisfy behavioral claim: %s",
    (criterion) => {
      const verdict = deterministicLedgerVerdict([criterion], quickAppFacts);
      expect(verdict.allMet).toBe(false);
      expect(verdict.undetermined).toEqual([criterion]);
    },
  );

  test("an unrelated verified URL does not satisfy an unnamed endpoint claim", () => {
    const criterion = "the API endpoint is available";
    const verdict = deterministicLedgerVerdict([criterion], quickAppFacts);
    expect(verdict.allMet).toBe(false);
    expect(verdict.undetermined).toEqual([criterion]);
  });

  test("a matching explicit URL can satisfy a reachability-only claim", () => {
    const verdict = deterministicLedgerVerdict(
      ["https://nubilio.org/apps/canon-clock/ is reachable"],
      quickAppFacts,
    );
    expect(verdict.allMet).toBe(true);
  });

  test("behavior words inside a matching URL path do not change its claim", () => {
    const url = "https://example.com/status/get-and-delete/";
    expect(
      deterministicLedgerVerdict([`${url} is reachable`], {
        ...quickAppFacts,
        verifiedPublicUrls: [url],
      }).allMet,
    ).toBe(true);
    expect(
      deterministicLedgerVerdict([`${url} returns HTTP 200`], {
        ...quickAppFacts,
        verifiedPublicUrls: [url],
      }).allMet,
    ).toBe(false);
  });

  test("empty criteria never auto-pass", () => {
    expect(deterministicLedgerVerdict([], quickAppFacts).allMet).toBe(false);
  });

  test("renders met bases and undetermined markers", () => {
    const rendered = renderDeterministicVerdict(
      deterministicLedgerVerdict(["the live URL is reachable", "tests pass"], {
        ...quickAppFacts,
        ledgerVerifiedFiles: [
          ...quickAppFacts.ledgerVerifiedFiles,
          "data/apps/canon-clock/main.ts",
        ],
      }),
    );
    expect(rendered).toContain("MET: the live URL is reachable");
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

describe("deterministic tool-result admission", () => {
  test.each(["running", "in_progress", "failed", "error", ""])(
    "rejects %s tool events",
    (status) => {
      expect(isCompletedToolEvidence({ status })).toBe(false);
    },
  );

  test("accepts only an explicit completed transition", () => {
    expect(isCompletedToolEvidence({ status: "completed" })).toBe(true);
    expect(isCompletedToolEvidence({ status: " COMPLETED " })).toBe(true);
  });

  test("rejects pass-looking output from a non-zero process", () => {
    expect(isGreenCheckOutput("PASS\n$ bun test → exit 1")).toBe(false);
    expect(isGreenCheckOutput("ok\nexit_code: 2")).toBe(false);
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
          "the live URL is reachable",
          "the page shows a ticking clock",
        ],
      });
    const criteria = await generateDefaultAcceptanceCriteria(goal, undefined, {
      useModel,
    } as never);
    expect(criteria.join("\n")).not.toContain("agent-home/canon-clock.html");
    expect(criteria).toContain("the live URL is reachable");
    expect(criteria.length).toBeGreaterThanOrEqual(3);
  });
});

describe("static-only deliverable check inapplicability (ember-tide live shape)", () => {
  const staticFacts = {
    verifiedPublicUrls: ["https://nubilio.org/apps/ember-tide/"],
    ledgerVerifiedFiles: ["data/apps/ember-tide/index.html"],
    hasChangeSet: false,
    greenChecks: { test: false, build: false, lint: false },
  };

  test("typecheck/lint/tests are vacuously met when the deliverable is static-only", () => {
    const verdict = deterministicLedgerVerdict(
      ["typecheck passes", "lint passes", "tests pass"],
      staticFacts,
    );
    expect(verdict.allMet).toBe(true);
    for (const result of verdict.results) {
      expect(result.basis).toContain("inapplicable");
    }
  });

  test("any code file in the deliverable keeps check criteria undetermined", () => {
    const verdict = deterministicLedgerVerdict(["typecheck passes"], {
      ...staticFacts,
      ledgerVerifiedFiles: [
        "data/apps/ember-tide/index.html",
        "data/apps/ember-tide/main.ts",
      ],
    });
    expect(verdict.allMet).toBe(false);
  });

  test("no verified files means no vacuous satisfaction", () => {
    const verdict = deterministicLedgerVerdict(["lint passes"], {
      ...staticFacts,
      ledgerVerifiedFiles: [],
    });
    expect(verdict.allMet).toBe(false);
  });

  test("green output still wins over the inapplicability leg", () => {
    const verdict = deterministicLedgerVerdict(["tests pass"], {
      ...staticFacts,
      greenChecks: { test: true, build: false, lint: false },
    });
    expect(verdict.results[0]?.basis).toBe("green test output captured");
  });
});
