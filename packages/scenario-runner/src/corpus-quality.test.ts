/** Tests fail-closed scenario authoring checks and the exact legacy-debt ratchet. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  assertScenarioQuality,
  inspectScenarioQuality,
  LEGACY_SCENARIO_QUALITY_DEBT,
} from "./corpus-quality.ts";
import { listScenarioMetadata, loadScenarioFile } from "./loader.ts";

function fixture(
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    id: "quality.fixture",
    title: "Quality fixture",
    domain: "quality",
    turns: [{ kind: "message", name: "ask", text: "Do the thing." }],
    ...overrides,
  };
}

describe("scenario corpus quality", () => {
  it("rejects zero response and final judge thresholds", () => {
    const issues = inspectScenarioQuality(
      fixture({
        turns: [
          {
            kind: "message",
            name: "ask",
            text: "Do the thing.",
            responseJudge: { rubric: "Did it work?", minimumScore: 0 },
          },
        ],
        finalChecks: [
          {
            type: "judgeRubric",
            name: "outcome",
            rubric: "Did it work end to end?",
            minimumScore: 0,
          },
        ],
      }),
    );

    expect(
      issues.filter((issue) => issue.code === "zero-judge-threshold"),
    ).toHaveLength(2);
  });

  it("normalizes and rejects duplicate action alternatives", () => {
    const issues = inspectScenarioQuality(
      fixture({
        turns: [
          {
            kind: "message",
            name: "ask",
            text: "Do the thing.",
            expectedActions: ["MESSAGE", " message "],
          },
        ],
        finalChecks: [
          {
            type: "selectedAction",
            actionName: ["LIFE", "life"],
          },
        ],
      }),
    );

    expect(
      issues.filter((issue) => issue.code === "duplicate-action-alternative"),
    ).toHaveLength(2);
  });

  it("normalizes and rejects duplicate turn names", () => {
    const issues = inspectScenarioQuality(
      fixture({
        turns: [
          { kind: "message", name: "Confirm send", text: "Send it." },
          { kind: "message", name: " confirm SEND ", text: "Yes." },
        ],
      }),
    );

    expect(issues).toContainEqual({
      code: "duplicate-turn-name",
      detail: "repeats turn names: confirm send",
    });
  });

  it("rejects certification claims from the default simulated profile", () => {
    const simulated = fixture({
      id: "connector.fixture.certify-core",
      title: "Connector certification",
    });
    const qualified = fixture({
      ...simulated,
      executionProfile: "provider-qualified",
    });

    expect(inspectScenarioQuality(simulated)).toContainEqual({
      code: "simulated-evidence-claim",
      detail:
        "simulated scenario uses certification or provider-evidence language",
    });
    expect(inspectScenarioQuality(qualified)).toEqual([]);
  });

  it("rejects custom final checks that always pass", () => {
    const issues = inspectScenarioQuality(
      fixture({
        finalChecks: [
          {
            type: "custom",
            name: "fake-success",
            predicate: () => undefined,
          },
        ],
      }),
    );

    expect(issues).toContainEqual({
      code: "unconditional-custom-predicate",
      detail: "finalChecks[0] (fake-success) always passes",
    });
  });

  it("fails closed for new evidence-claim debt with no grandfathered IDs", () => {
    expect(LEGACY_SCENARIO_QUALITY_DEBT["simulated-evidence-claim"].size).toBe(
      0,
    );
    expect(() =>
      assertScenarioQuality(
        fixture({
          id: "connector.new.certify-core",
          title: "Connector certification",
        }),
        "new.scenario.ts",
      ),
    ).toThrow(/simulated-evidence-claim/);
  });

  it("enforces quality checks at the scenario loader boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scenario-quality-"));
    const file = join(dir, "duplicate-turns.scenario.ts");
    await writeFile(
      file,
      [
        "export default {",
        '  id: "quality.loader-fixture",',
        '  title: "Loader fixture",',
        '  domain: "quality",',
        "  turns: [",
        '    { kind: "message", name: "same", text: "One." },',
        '    { kind: "message", name: "same", text: "Two." },',
        "  ],",
        "};",
      ].join("\n"),
    );

    try {
      await expect(loadScenarioFile(file)).rejects.toThrow(
        /scenario-quality.*duplicate-turn-name/s,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires explicit evidence classification across maintained corpora", async () => {
    const roots = [
      "../../../packages/test/scenarios",
      "../../../plugins/plugin-personal-assistant/test/scenarios",
    ].map((root) => resolve(import.meta.dirname, root));
    const metadata = (
      await Promise.all(
        roots.map((root) =>
          listScenarioMetadata(root, undefined, undefined, false),
        ),
      )
    ).flat();
    const defaulted = metadata
      .filter((entry) => entry.evidenceScopeDefaulted)
      .map((entry) => `${entry.id} (${entry.file})`)
      .sort();

    expect(defaulted).toEqual([]);
  }, 15_000);
});
