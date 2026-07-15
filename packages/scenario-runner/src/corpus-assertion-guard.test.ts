/**
 * Corpus assertion guard.
 *
 * The scenario-runner runs a scenario's turns and only fails when an assertion
 * fails. A scenario with no enforceable assertion therefore passes vacuously -
 * it proves nothing while counting as green coverage. This guard makes that
 * failure mode impossible to (re)introduce.
 *
 * Two invariants enforced here:
 *  1. No `pr-deterministic` scenario may lack an enforceable assertion. The
 *     pr-deterministic lane is the merge-blocking PR gate; a vacuous scenario
 *     there is false confidence on every PR. "Enforceable" means a non-empty
 *     `finalChecks` array OR a per-turn assertion the executor actually runs
 *     (`assertResponse` / `expectedActions` / `responseIncludesAny` /
 *     `responseIncludesAll` / `responseExcludes` / `forbiddenActions` /
 *     `plannerIncludesAll` / `plannerIncludesAny` / `plannerExcludes` /
 *     `responseJudge` / `assertTurn`).
 *  2. `personalityExpect` scenarios must run `live-only`. Their behaviour
 *     (silence / held-style / trait-respected ...) can only be exercised by a
 *     real model - the deterministic proxy always emits a reply, so the
 *     personality judge can never pass under the proxy. They are not valid
 *     deterministic PR coverage and must not claim the pr-deterministic lane.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");

const SCENARIO_ROOTS = [
  "packages/test/scenarios",
  "plugins/plugin-personal-assistant/test/scenarios",
  "plugins/plugin-app-control/test/scenarios",
  "plugins/plugin-health/test/scenarios",
  "plugins/plugin-agent-orchestrator/test/scenarios",
].map((r) => resolve(repoRoot, r));

function walkScenarioFiles(dir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("_")) continue; // loader ignores `_`-prefixed entries
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkScenarioFiles(full));
    } else if (entry.endsWith(".scenario.ts")) {
      out.push(full);
    }
  }
  return out;
}

interface ScenarioFacts {
  file: string;
  id: string;
  lane: string;
  hasFinalChecks: boolean;
  hasPerTurnAssert: boolean;
  hasPersonalityExpect: boolean;
  hasExpectedActionParams: boolean;
  hasMessageAsGmailLabelExpectation: boolean;
  deadTurnAssertionFields: string[];
  duplicateTopLevelFields: string[];
}

const DEAD_EXPECTED_ACTION_PARAMS = /\bexpectedActionParams\s*:/;
const MESSAGE_AS_GMAIL_LABEL_EXPECTATION =
  /\b(?:addLabelIds|removeLabelIds)\s*:\s*(?:(["'])MESSAGE\1|\[[^\]]*(["'])MESSAGE\2[^\]]*\])/;
const DEAD_TURN_ASSERTION_FIELD_FIXES = {
  acceptedActions: "expectedActions",
  includesAny: "responseIncludesAny",
  waitForDefinitionTitle: "finalChecks/custom predicate",
  waitForDefinitionTitleAliases: "finalChecks/custom predicate",
} as const;

const PER_TURN_ASSERT =
  /\b(assertResponse|expectedActions|responseIncludesAny|responseIncludesAll|responseExcludes|forbiddenActions|plannerIncludesAll|plannerIncludesAny|plannerExcludes|responseJudge|assertTurn)\b/;
// A non-empty finalChecks array: `finalChecks: [` followed by a non-`]`,
// non-whitespace char. `finalChecks: []` does not match.
const NON_EMPTY_FINAL_CHECKS = /finalChecks\s*:\s*\[\s*[^\]\s]/;

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function scenarioObjectFromExpression(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | null {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isCallExpression(expression)) {
    const [firstArg] = expression.arguments;
    if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
      return firstArg;
    }
  }
  return null;
}

function findExportedScenarioObject(
  sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | null {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const objectLiteral = scenarioObjectFromExpression(statement.expression);
      if (objectLiteral) return objectLiteral;
    }

    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== "scenario") continue;
      if (!declaration.initializer) continue;
      const objectLiteral = scenarioObjectFromExpression(
        declaration.initializer,
      );
      if (objectLiteral) return objectLiteral;
    }
  }

  return null;
}

function getStaticStringPropertyValues(
  objectLiteral: ts.ObjectLiteralExpression | null,
  propertyName: string,
): string[] {
  if (!objectLiteral) return [];
  const values: string[] = [];
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name !== propertyName) continue;
    const initializer = property.initializer;
    if (
      ts.isStringLiteral(initializer) ||
      ts.isNoSubstitutionTemplateLiteral(initializer)
    ) {
      values.push(initializer.text);
    }
  }
  return values;
}

function duplicateTopLevelFields(
  objectLiteral: ts.ObjectLiteralExpression | null,
  fields: ReadonlyArray<string>,
): string[] {
  if (!objectLiteral) return [];
  const counts = new Map<string, number>();
  for (const property of objectLiteral.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const name = propertyNameText(property.name);
    if (!name || !fields.includes(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return fields.filter((field) => (counts.get(field) ?? 0) > 1);
}

function collectDirectTurnKeys(sourceFile: ts.SourceFile): Set<string> {
  const keys = new Set<string>();

  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      propertyNameText(node.name) === "turns" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        for (const prop of element.properties) {
          if (
            ts.isPropertyAssignment(prop) ||
            ts.isMethodDeclaration(prop) ||
            ts.isShorthandPropertyAssignment(prop)
          ) {
            const key = propertyNameText(prop.name);
            if (key) keys.add(key);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return keys;
}

function analyze(file: string): ScenarioFacts {
  const src = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const scenarioObject = findExportedScenarioObject(sourceFile);
  const directTurnKeys = collectDirectTurnKeys(sourceFile);
  const idValues = getStaticStringPropertyValues(scenarioObject, "id");
  const laneValues = getStaticStringPropertyValues(scenarioObject, "lane");
  return {
    file,
    id: idValues.at(-1) ?? "",
    lane: laneValues.at(-1) ?? "live-only", // schema default is live-only
    hasFinalChecks: NON_EMPTY_FINAL_CHECKS.test(src),
    hasPerTurnAssert: PER_TURN_ASSERT.test(src),
    hasPersonalityExpect: /\bpersonalityExpect\s*:/.test(src),
    hasExpectedActionParams: DEAD_EXPECTED_ACTION_PARAMS.test(src),
    hasMessageAsGmailLabelExpectation:
      MESSAGE_AS_GMAIL_LABEL_EXPECTATION.test(src),
    deadTurnAssertionFields: Object.keys(
      DEAD_TURN_ASSERTION_FIELD_FIXES,
    ).filter((field) => directTurnKeys.has(field)),
    duplicateTopLevelFields: duplicateTopLevelFields(scenarioObject, [
      "id",
      "lane",
    ]),
  };
}

const facts: ScenarioFacts[] =
  SCENARIO_ROOTS.flatMap(walkScenarioFiles).map(analyze);
const rel = (f: ScenarioFacts) => relative(repoRoot, f.file);
const EXPECTED_PR_DETERMINISTIC_SCENARIO_IDS = [
  // LifeOps persona pack A1 (adhd-capture-and-start, #12769). Convention (G1):
  // pr-deterministic persona scenarios live in
  // plugins/plugin-personal-assistant/test/scenarios — the one root scanned by
  // BOTH this guard AND check-lifeops-persona-catalog-coverage.mjs — and are
  // added here in the same commit so this toEqual stays green while the coverage
  // ledger can still resolve their ids.
  "adhd-distractor-storm-mid-capture",
  // LifeOps persona pack A2 (adhd-follow-through, #12770). Same G1 convention:
  // these keyless api+tick scenarios drive the REAL no-reply/escalation ladder
  // (create a reminder with a completionCheck, tick across simulated no-reply,
  // assert the retry -> re-fire -> skip/expire progression + reminderIntensity
  // differences) and are registered here in the same commit.
  "adhd-followthrough-intensity-minimal-chases-none",
  "adhd-followthrough-intensity-persistent-chases-twice",
  "adhd-followthrough-noreply-retry-then-skip",
  "adhd-followthrough-reply-breaks-escalation",
  "adhd-hyperfocus-guardrail-protects-standup",
  // LifeOps persona pack C1 (traveler-timezone-truth, #12773). Same G1
  // convention: keyless `tick`-driven timezone journeys authored under
  // plugins/plugin-personal-assistant/test/scenarios and pinned here in the same
  // commit. They prove the travel/tz spine — owner_local cron re-anchoring to
  // the active-travel destination while a fixed absolute instant stays
  // invariant, a wall-clock morning window re-anchoring, DST local-time
  // integrity across a fall-back, and a disruption re-time — through the real
  // scheduler under the deterministic proxy.
  "traveler-absolute-vs-wallclock-disambiguation-flight",
  "traveler-disruption-recovery-missed-connection",
  "traveler-dst-boundary-reminder-integrity",
  "traveler-reanchor-on-timezone-change-signal",
  // LifeOps persona pack E1 (low-activation-reengagement, #12775). Same G1
  // convention: pr-deterministic scenarios live under plugin-personal-assistant
  // and are added here in the same commit.
  "lowact-micro-step-deferred-not-dropped",
  "lowact-morning-single-priority-fires-once",
  "lowact-quiet-streak-softens-next-nudge",
  "lowact-values-anchored-activity-fires-in-window",
  // LifeOps persona pack F1 (neurotypical-control-adversarial, #12776). Same G1
  // convention: keyless api+tick canaries proving the D1/E1/B1/C1 persona
  // accommodations do NOT leak into a plain/neutral owner (literal cadence,
  // standard quiet hours, literal zoned time, fail-closed approvals).
  "f1-adversarial-highstakes-confirmation-fail-closed",
  "f1-cross-persona-quiet-hours-respected-baseline",
  "f1-multiday-recurrence-control-baseline",
  "f1-timezone-boundary-edge-generic",
  "agent-orchestrator.list-agents",
  // #14630 reject-routing: keyless proof that pending approval-queue rows are
  // visible to the planner (pendingApprovals provider) and that RESOLVE_REQUEST
  // reject terminally resolves them. Lives under plugin-personal-assistant per
  // the G1 convention; live routing stays on
  // f1-cross-persona-wrong-recipient-highstakes.
  "approval-queue-pending-visible-to-planner",
  // LifeOps persona pack B1 (night-owl-anchored-day, #12771). Same G1
  // convention as A1: authored under the SCANNED root
  // packages/test/scenarios/lifeops.personas and added here in the same commit.
  "persona.night-owl-anchored-day",
  "persona.night-owl-quiet-hours-sleep-protection",
  "anthropic-proxy.proxy-status",
  "benchmarks.osworld-action",
  // Per-plugin keyless coverage (#8801, cluster 1 of #15759): keyless scenarios
  // that spawn a fake birdclaw CLI, mock the Eliza Cloud HTTP API, and drive a
  // scripted MeetingService so BIRDCLAW / CLOUD_ACCOUNT_STATUS /
  // GET_MEETING_TRANSCRIPT each get a credential-free e2e. Added here in the same
  // commit so this toEqual stays green.
  "birdclaw.search-archive",
  "commands.help-command",
  // LifeOps persona pack D1 (comms-flood-triage, #12774). Convention (G1):
  // pr-deterministic persona scenarios live in
  // plugins/plugin-personal-assistant/test/scenarios — the one root scanned by
  // BOTH this guard AND check-lifeops-persona-catalog-coverage.mjs — and are
  // added here in the same commit so this toEqual stays green while the coverage
  // ledger can still resolve their ids.
  "comms-flood-quiet-hours-vip-exception",
  "computeruse.get-cursor-position",
  "convo.echo-self-test",
  "convo.greeting-dynamic",
  "elizacloud.account-status",
  "facewear.smartglasses-status",
  "finances.owner-finances-dashboard",
  "form.restore-stashed",
  // LifeOps persona pack G1 (overdue-comms-apology, #14783). Keyless
  // structural proof that overdue relationship follow-up cadence uses
  // SCHEDULED_TASKS fields rather than prompt text.
  "g1-followup-cadence-reset",
  // LifeOps persona pack G2 (reconnect-old-friends, #14784). Keyless
  // structural proof for relationship-cadence follow-up creation.
  "g2-cadence-watcher-due",
  "goals.owner-goals-create",
  // LifeOps knowledge-graph capture pack H2 (#14786). Keyless direct-action
  // scenarios that drive the REAL ENTITY set_relationship / merge subactions and
  // read the captured primitive back off the per-agent RelationshipStore /
  // EntityStore (`eliza_knowledge_graph` service), asserting persisted rows
  // rather than the scripted action arguments. Registered here in the same
  // commit that flips their lane to pr-deterministic.
  "h2-audit-trail-survives-restart",
  "h2-conflicting-fact-resolution",
  "h2-identity-merge-uses-engine",
  "h2-relationship-update-live",
  "health.owner-health-status",
  "hyperliquid.perpetual-market-status",
  "inbox.summarize-inboxes",
  "linear.search-issues",
  "local-inference.start-transcription",
  // Transcript permissioning (#14779): keyless proof that SHARE_TRANSCRIPT
  // routes message -> planner -> TranscriptStore and that the disclosure
  // predicate serves the redacted variant to a non-privileged colleague while
  // an admin keeps the untouched original. Added here in the same commit.
  "local-inference.transcript-permissioning",
  "meetings.get-transcript",
  "music.routing-status",
  "nostr.search-posts",
  // Registered here retroactively: the scenario landed (#13778) without the
  // same-commit guard update this list requires, leaving the guard red.
  // Orchestrator deterministic scenarios from the de-larp sweep (#16256),
  // registered here retroactively for the same reason as the block above.
  "orchestrator-completion-residuals",
  "orchestrator-concurrency-admission",
  "orchestrator-device-modality-reach",
  "orchestrator-evidence-bundle",
  "orchestrator-follow-up-forwarding",
  "orchestrator-grilling-happy-path",
  "orchestrator-multi-project-failure-isolation",
  "orchestrator-multi-project-portfolio",
  "orchestrator-multi-task-supervisor",
  "orchestrator-question-for-creator",
  "orchestrator-reflexion-respawn",
  "orchestrator-view-cloud-deploy",
  "orchestrator-watchdog-stall",
  "persona.flexible-scheduling",
  "relationships.list-entities",
  "reminder.cross-platform.acknowledged-syncs",
  "reminder.cross-platform.fires-on-mac-and-phone",
  "reminder.escalation.intensity-up",
  "reminder.escalation.silent-dismiss",
  "remote-desktop.list-sessions",
  // LifeOps persona pack B2 (shift-rotation, marcus_shift, #12772). Convention
  // (G1): pr-deterministic persona scenarios live in
  // plugins/plugin-personal-assistant/test/scenarios — the one root scanned by
  // BOTH this guard AND check-lifeops-persona-catalog-coverage.mjs — and are
  // added here in the same commit so this toEqual stays green while the coverage
  // ledger can still resolve their ids.
  "shift-rotation-reanchor-protects-new-sleep-window",
  "shift-rotation-sleep-protection-holds-low-priority-nudge",
  "shift-rotation-wake-anchor-follows-shifted-window",
  "suno.generate-music",
  "task-coordinator.orchestrator-status",
  "tunnel.status",
  "vision.set-mode",
  "wallet.token-info",
].sort();

describe("scenario corpus assertion guard", () => {
  it("scans a meaningful number of scenario files", () => {
    // Guards against a path/glob regression silently scanning nothing.
    expect(facts.length).toBeGreaterThan(500);
  });

  it("does not declare duplicate top-level scenario id or lane fields", () => {
    const offenders = facts
      .filter((f) => f.duplicateTopLevelFields.length > 0)
      .map((f) => `${rel(f)} (${f.duplicateTopLevelFields.join(", ")})`)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("tracks the current external pr-deterministic corpus explicitly", () => {
    const ids = facts
      .filter((f) => f.lane === "pr-deterministic")
      .map((f) => f.id)
      .sort();
    expect(ids).toEqual(EXPECTED_PR_DETERMINISTIC_SCENARIO_IDS);
  });

  it("no pr-deterministic scenario lacks an enforceable assertion", () => {
    const offenders = facts
      .filter(
        (f) =>
          f.lane === "pr-deterministic" &&
          !f.hasFinalChecks &&
          !f.hasPerTurnAssert,
      )
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("personalityExpect scenarios run live-only (cannot be judged under the deterministic proxy)", () => {
    const misLaned = facts
      .filter((f) => f.hasPersonalityExpect && f.lane !== "live-only")
      .map(rel)
      .sort();
    expect(misLaned).toEqual([]);
  });

  it("does not use dead expectedActionParams turn assertions", () => {
    const offenders = facts
      .filter((f) => f.hasExpectedActionParams)
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('does not use action name "MESSAGE" as a Gmail label expectation', () => {
    const offenders = facts
      .filter((f) => f.hasMessageAsGmailLabelExpectation)
      .map(rel)
      .sort();
    expect(offenders).toEqual([]);
  });

  it("does not grow unenforced turn assertion typo fields", () => {
    const DEAD_TURN_ASSERTION_BASELINE = {
      acceptedActions: 0,
      includesAny: 0,
      waitForDefinitionTitle: 1,
      waitForDefinitionTitleAliases: 1,
    } as const satisfies Record<
      keyof typeof DEAD_TURN_ASSERTION_FIELD_FIXES,
      number
    >;

    for (const [field, replacement] of Object.entries(
      DEAD_TURN_ASSERTION_FIELD_FIXES,
    )) {
      const users = facts
        .filter((f) => f.deadTurnAssertionFields.includes(field))
        .map(rel)
        .sort();
      const baseline =
        DEAD_TURN_ASSERTION_BASELINE[
          field as keyof typeof DEAD_TURN_ASSERTION_BASELINE
        ];
      if (users.length > baseline) {
        throw new Error(
          `unenforced turn assertion field ${field} grew to ${users.length} ` +
            `(baseline ${baseline}). The executor ignores turn-level ${field}; ` +
            `use ${replacement} or a real finalCheck instead. New offenders:\n` +
            users.slice(baseline).join("\n"),
        );
      }
      expect(users.length).toBeLessThanOrEqual(baseline);
    }
  });

  it("counts planner matchers as enforceable per-turn assertions", () => {
    const plannerAsserted = facts.filter((f) =>
      /\b(plannerIncludesAll|plannerIncludesAny|plannerExcludes)\s*:/.test(
        readFileSync(f.file, "utf8"),
      ),
    );
    expect(plannerAsserted.length).toBeGreaterThan(0);
    expect(plannerAsserted.every((f) => f.hasPerTurnAssert)).toBe(true);
  });
});
