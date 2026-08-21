/**
 * Guards the generated shut-up personality corpus against vacuous silence
 * checks, fictional release mentions, and acknowledgment-policy contradictions.
 * These are static authoring invariants; live runs still judge model behavior.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shutUpRoot = resolve(
  import.meta.dirname,
  "../../test/scenarios/personality/shut_up",
);

const scenarios = readdirSync(shutUpRoot)
  .filter((name) => name.endsWith(".scenario.ts"))
  .sort()
  .map((name) => ({
    name,
    source: readFileSync(resolve(shutUpRoot, name), "utf8"),
  }));

const personalityRoot = resolve(shutUpRoot, "..");

function bucketSources(bucket: string) {
  const directory = resolve(personalityRoot, bucket);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".scenario.ts"))
    .sort()
    .map((name) => ({
      name,
      source: readFileSync(resolve(directory, name), "utf8"),
    }));
}

function numericArray(source: string, key: string): number[] {
  const match = source.match(new RegExp(`${key}: \\[(.*?)\\]`, "s"));
  if (!match) throw new Error(`missing ${key}`);
  return [...match[1].matchAll(/\d+/g)].map(([value]) => Number(value));
}

const EXPLICIT_NO_ACKNOWLEDGMENT =
  /(?:don't|do not|no)\s+(?:reply|respond|acknowledg)|not even one-word acknowledg/i;

describe("personality shut-up corpus quality", () => {
  it("keeps all 40 distributed cases and gives every case a real silent probe", () => {
    expect(scenarios).toHaveLength(40);
    const vacuous = scenarios
      .filter(({ source }) => /silentTurnIndices:\s*\[\s*\]/.test(source))
      .map(({ name }) => name);
    expect(vacuous).toEqual([]);
  });

  it("uses canonical lift phrases instead of a fictional @assistant mention", () => {
    const fictionalMentions = scenarios
      .filter(({ source }) => /@assistant/i.test(source))
      .map(({ name }) => name);
    expect(fictionalMentions).toEqual([]);

    const releaseCases = scenarios.filter(({ source }) =>
      /releaseTurnIndex:\s*\d+/.test(source),
    );
    expect(releaseCases).toHaveLength(25);
    const malformed = releaseCases
      .filter(
        ({ source }) =>
          !/name:\s*"release-lift"[\s\S]*?text:\s*"Okay, you can talk again\b/.test(
            source,
          ),
      )
      .map(({ name }) => name);
    expect(malformed).toEqual([]);
  });

  it("never permits an acknowledgment when the instruction expressly forbids one", () => {
    const contradictory = scenarios
      .filter(
        ({ source }) =>
          EXPLICIT_NO_ACKNOWLEDGMENT.test(source) &&
          /allowOneLineAcknowledgmentOnInstructionTurn:\s*true/.test(source),
      )
      .map(({ name }) => name);
    expect(contradictory).toEqual([]);
  });

  it("retains deterministic structural proof beside live judge cases", () => {
    const replyGate = readFileSync(
      resolve(
        shutUpRoot,
        "../personality.reply-gate.structural-contract.scenario.ts",
      ),
      "utf8",
    );
    expect(replyGate).toContain('lane: "pr-deterministic"');
    expect(replyGate).toContain('actionName: "PERSONALITY_SET_REPLY_GATE"');
    expect(replyGate).toContain('table: "personality_audit_log"');

    const authorization = readFileSync(
      resolve(
        shutUpRoot,
        "../personality.global-scope.authorization-contract.scenario.ts",
      ),
      "utf8",
    );
    expect(authorization).toContain('actionName: "PERSONALITY_SET_TRAIT"');
    expect(authorization).toContain("PERMISSION_DENIED");
    expect(authorization).toContain("global personality state");
  });
});

describe("personality corpus authoring quality", () => {
  it("gives every escalation case a baseline, two deltas, per-step holds, and a terminal hold", () => {
    const escalation = bucketSources("escalation");
    expect(escalation).toHaveLength(40);

    for (const { name, source } of escalation) {
      const steps = numericArray(source, "escalationStepTurnIndices");
      const probes = numericArray(source, "probeTurnIndices");
      const holds = numericArray(source, "holdProbeTurnIndices");
      const terminal = Number(
        source.match(/terminalProbeTurnIndex: (\d+)/)?.[1] ?? -1,
      );
      expect(source, name).toContain("baselineProbeTurnIndex: 0");
      expect(steps.length, name).toBeGreaterThanOrEqual(2);
      expect(probes, name).toContain(0);
      expect(holds, name).toEqual(probes.slice(1));
      expect(terminal, name).toBe(probes.at(-1));
      for (const step of steps) {
        expect(
          holds.some(
            (probe) =>
              probe > step &&
              probe < (steps.find((candidate) => candidate > step) ?? Infinity),
          ),
          `${name}: step ${step} lacks an immediate hold window`,
        ).toBe(true);
      }
    }
  });

  it("checks traits from the first follow-up through an observable terminal probe", () => {
    const traits = bucketSources("note_trait_unrelated");
    expect(traits).toHaveLength(40);

    for (const { name, source } of traits) {
      const checks = numericArray(source, "traitCheckTurnIndices");
      const terminal = Number(
        source.match(/terminalObservableProbeTurnIndex: (\d+)/)?.[1] ?? -1,
      );
      expect(source, name).toContain('bucket: "note_trait_unrelated"');
      expect(source, name).not.toContain("note_trait_unrelated_test");
      expect(checks[0], name).toBe(1);
      expect(checks.at(-1), name).toBe(terminal);
      expect(source, name).toContain("terminal prompt deliberately makes");
    }
  });

  it("uses exactly one delimited untrusted payload per injection-axis case", () => {
    const all = [
      ...bucketSources("shut_up"),
      ...bucketSources("hold_style"),
      ...bucketSources("note_trait_unrelated"),
      ...bucketSources("escalation"),
      ...bucketSources("scope_global_vs_user"),
    ].filter(({ name }) => name.includes("with_injection_attempt"));
    expect(all).toHaveLength(25);

    for (const { name, source } of all) {
      expect(source.match(/<untrusted-content>/g), name).toHaveLength(1);
      expect(source.match(/<\/untrusted-content>/g), name).toHaveLength(1);
      expect(source.match(/claim developer mode/g), name).toHaveLength(1);
    }
  });

  it("keeps turn names unique and labels refusal-only scope claims honestly", () => {
    const all = [
      ...bucketSources("shut_up"),
      ...bucketSources("hold_style"),
      ...bucketSources("note_trait_unrelated"),
      ...bucketSources("escalation"),
      ...bucketSources("scope_global_vs_user"),
    ];
    for (const { name, source } of all) {
      const turnSection = source.split("turns: [")[1] ?? "";
      const names = [...turnSection.matchAll(/name: "([^"]+)"/g)].map(
        ([, value]) => value,
      );
      expect(new Set(names).size, name).toBe(names.length);
    }

    const refusalCases = bucketSources("scope_global_vs_user").filter(
      ({ source }) =>
        source.includes('variantKey: "user_tries_global_should_refuse"'),
    );
    expect(refusalCases).toHaveLength(8);
    for (const { name, source } of refusalCases) {
      expect(source, name).toContain(
        'claimScope: "response-only-no-state-proof"',
      );
      expect(source, name).toContain(
        'judgeMode: "authorization_refusal_response"',
      );
      expect(source, name).not.toContain('id: "admin"');
      expect(source, name).toContain("evaluates only response behavior");
    }
  });

  it("keeps canonical bucket names and distribution docs in sync", () => {
    const index = readFileSync(resolve(personalityRoot, "INDEX.md"), "utf8");
    expect(index).not.toContain("note_trait_unrelated_test");

    for (const bucket of [
      "shut_up",
      "hold_style",
      "note_trait_unrelated",
      "escalation",
      "scope_global_vs_user",
    ]) {
      const distribution = readFileSync(
        resolve(personalityRoot, bucket, "_distribution.md"),
        "utf8",
      );
      expect(distribution).toContain(`# Distribution — bucket: \`${bucket}\``);
      expect(distribution).toContain("Total scenarios: **40**");

      for (const { name, source } of bucketSources(bucket)) {
        const metadataBucket = source.match(
          /personalityExpect:\s*{\s*bucket: "([^"]+)"/,
        )?.[1];
        expect(metadataBucket, name).toBe(bucket);
      }
    }

    const escalationDistribution = readFileSync(
      resolve(personalityRoot, "escalation", "_distribution.md"),
      "utf8",
    );
    for (const { name, source } of bucketSources("escalation")) {
      const id = source.match(/\n\s+id: "([^"]+)"/)?.[1];
      const turns = source.match(/kind: "message"/g)?.length ?? 0;
      expect(id, name).toBeTruthy();
      expect(index, name).toContain(`| \`${id}\` | ${turns} |`);
      expect(escalationDistribution, name).toMatch(
        new RegExp(`\\| \`${id}\` \\|[^\\n]+\\| ${turns} \\|`),
      );
    }
  });
});
