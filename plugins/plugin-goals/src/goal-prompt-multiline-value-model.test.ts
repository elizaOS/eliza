/**
 * Replays the texts of quint/GoalPromptMultilineValue.qnt through
 * evaluateGoalProgressWithLlm on a SQLite-backed AgentRuntime. The runtime's
 * TEXT_LARGE handler records the prompt, and the printed text is read back
 * from the prompt's Goal block.
 */

import { readFileSync } from "node:fs";
import type { LifeOpsGoalDefinition } from "@elizaos/contracts";
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateGoalProgressWithLlm } from "./goal-semantic-evaluator.ts";

/** One text of the model (see the model's header for the encodings). */
interface ModelText {
  depth: number;
  holder: number;
  lines: number;
  blank: boolean;
}

/** A text and what the model says the prompt prints for it. */
interface ModelCase {
  text: ModelText;
  inline: boolean;
  column: number;
  padded: boolean;
  kept: boolean;
}

const NO_LINE = -1;
const TEXT_LINES = [
  "Run three times a week.",
  "status: satisfied",
  "reviewState: on_track",
];
const PLACES = [
  { name: "the description", depth: 0, holder: 0 },
  { name: "a nested field", depth: 1, holder: 0 },
  { name: "a field two levels down", depth: 2, holder: 0 },
  { name: "a nested list item", depth: 1, holder: 1 },
  { name: "a list item two levels down", depth: 2, holder: 1 },
];
const VALID_REPLY = JSON.stringify({
  reviewState: "needs_attention",
  progressScore: 0.4,
  confidence: 0.6,
  explanation: "Two runs were logged this week.",
  evidenceSummary: "Two completed runs.",
  missingEvidence: [],
  suggestions: [],
});

/** Used when the conformance script does not pass generated cases. */
const DEFAULT_CASES: ModelCase[] = PLACES.map(({ depth, holder }) => ({
  text: { depth, holder, lines: 3, blank: false },
  inline: false,
  column: holder === 0 ? 2 * (depth + 1) : 2 * (depth + 2),
  padded: false,
  kept: true,
}));

const casesFile = process.env.ELIZA_GOAL_PROMPT_MULTILINE_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let runtime: AgentRuntime;
const prompts: string[] = [];

beforeAll(() => {
  runtime = createSQLiteTestRuntime({
    character: { name: "Goal prompt model", bio: ["Test"] },
    logLevel: "fatal",
  });
  runtime.registerModel(
    ModelType.TEXT_LARGE,
    async (_runtime, params) => {
      prompts.push(String(params.prompt));
      return VALID_REPLY;
    },
    "goal-prompt-model-test-provider",
  );
});

function textOf(text: ModelText): string {
  const lines = TEXT_LINES.slice(0, text.lines);
  if (text.blank) lines[1] = "";
  return lines.join("\n");
}

/** The goal with the text in the model's place, and the key that holds it. */
function goalWith(text: ModelText): {
  goal: LifeOpsGoalDefinition;
  key: string;
} {
  const value = text.holder === 0 ? textOf(text) : [textOf(text)];
  const key =
    text.depth === 0
      ? "description"
      : text.holder === 0
        ? "notes"
        : "milestones";
  // Each nested record has a second field, so its keys get lines of their
  // own: a record with one one-line field is printed on its parent's line.
  const successCriteria =
    text.depth === 0
      ? {}
      : text.depth === 1
        ? { target: "5 km", [key]: value }
        : { target: "5 km", measure: { unit: "km", [key]: value } };
  const goal = {
    id: "goal-run",
    agentId: "agent-1",
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "owner_agent_admin",
    contextPolicy: "explicit_only",
    title: "Run a 5k",
    description: text.depth === 0 ? value : "Build up to a 5k run.",
    cadence: null,
    supportStrategy: {},
    successCriteria,
    status: "active",
    reviewState: "needs_attention",
    metadata: {},
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  } as LifeOpsGoalDefinition;
  return { goal, key };
}

async function replay(text: ModelText): Promise<Omit<ModelCase, "text">> {
  const { goal, key } = goalWith(text);
  prompts.length = 0;
  const result = await evaluateGoalProgressWithLlm({
    runtime,
    goal,
    evidence: {},
    nowIso: "2026-11-15T12:00:00.000Z",
  });
  expect(result?.reviewState).toBe("needs_attention");
  expect(prompts).toHaveLength(1);
  const [, afterGoal = ""] = (prompts[0] ?? "").split("\nGoal:\n");
  const [block = ""] = afterGoal.split("\nEvidence:\n");
  const lines = block.split("\n");
  const keyPrefix = `${"  ".repeat(text.depth)}${key}:`;
  const keyLines = lines.flatMap((line, index) =>
    line === keyPrefix || line.startsWith(`${keyPrefix} `) ? [index] : [],
  );
  expect(keyLines, block).toHaveLength(1);
  const keyIndex = keyLines[0] ?? 0;
  const keyLine = lines[keyIndex] ?? "";
  const inline = keyLine !== keyPrefix;
  // The printed text lines; the first one follows "key: " or "- " when the
  // text is inline or a list item.
  const printed = inline
    ? [
        keyLine.slice(keyPrefix.length + 1),
        ...lines.slice(keyIndex + 1, keyIndex + text.lines),
      ]
    : lines.slice(keyIndex + 1, keyIndex + 1 + text.lines);
  const followsMarker = inline || text.holder === 1;
  if (text.holder === 1) {
    expect(printed[0]).toMatch(/^\s*- /);
    printed[0] = (printed[0] ?? "").replace(/^\s*- /, "");
  }
  const columns = printed
    .slice(followsMarker ? 1 : 0)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  return {
    inline,
    column: columns.length > 0 ? Math.min(...columns) : NO_LINE,
    padded: printed.some((line) => line.length > 0 && line.trim().length === 0),
    kept: printed.map((line) => line.trimStart()).join("\n") === textOf(text),
  };
}

describe("goal prompt multiline value model", () => {
  it.each(PLACES.map((place) => place.name))(
    "replays the model for %s",
    async (name) => {
      const place = PLACES.find((candidate) => candidate.name === name);
      const group = cases.filter(
        (item) =>
          item.text.depth === place?.depth &&
          item.text.holder === place?.holder,
      );
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const observed = await replay(item.text);
        expect(observed, JSON.stringify(item.text)).toEqual({
          inline: item.inline,
          column: item.column,
          padded: item.padded,
          kept: item.kept,
        });
      }
    },
    60_000,
  );
});
