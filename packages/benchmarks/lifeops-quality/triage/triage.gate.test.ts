/**
 * Inbox-triage precision/recall gate (#10723) — drives the REAL classifier
 * (`classifyMessages` in plugins/plugin-inbox/src/inbox/triage-classifier.ts)
 * over the committed labeled corpus with a deterministic mock model that
 * answers from committed fixtures (a model of fixed quality — see
 * fixtures.ts). The classifier's prompt-build → parse → validate →
 * fail-closed path is the code under test; nothing here reimplements it.
 *
 * The mock resolves each batch's answers by matching the `text:` lines the
 * REAL prompt builder emitted back to corpus items, then wraps them in a
 * per-batch response envelope that rotates through every parse path the
 * classifier supports (plain results object, fenced legacy array,
 * <think>-prefixed object, column format, alias keys, fenced object) — so a
 * regression in ANY accepted shape surfaces as missing/failed rows here.
 *
 * Scores gate against budgets.json floors and must reproduce the committed
 * baseline.json triage block EXACTLY (the pipeline is fully deterministic:
 * no clock, no Intl, no network). The measured run lands in
 * results/triage-results.json.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyMessages,
  InboxTriageClassificationError,
} from "../../../../plugins/plugin-inbox/src/inbox/triage-classifier.ts";
import type { InboundMessage } from "../../../../plugins/plugin-inbox/src/inbox/types.ts";
import baseline from "../baseline.json";
import budgets from "../budgets.json";
import {
  PRIORITY_SENDERS,
  TRIAGE_CLASSES,
  TRIAGE_CORPUS,
  type TriageCorpusItem,
} from "./corpus.ts";
import { TRIAGE_FIXTURES, type TriageFixtureAnswer } from "./fixtures.ts";
import { scoreTriage, type TriageScore } from "./metrics.ts";

const RESULTS_PATH = fileURLToPath(
  new URL("../results/triage-results.json", import.meta.url),
);

/** Mirror of the classifier's formatPromptScalar for text fields. */
function promptScalar(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function toInboundMessage(
  item: TriageCorpusItem,
  index: number,
): InboundMessage {
  return {
    id: `bench-${item.id}`,
    source: item.source,
    senderName: item.senderName,
    channelName: item.channelName,
    channelType: item.channelType,
    text: item.text,
    snippet: item.text.slice(0, 120),
    timestamp: 1_772_000_000_000 + index * 60_000,
    ...(item.gmailIsImportant ? { gmailIsImportant: true } : {}),
    ...(item.gmailLikelyReplyNeeded ? { gmailLikelyReplyNeeded: true } : {}),
    ...(item.threadMessages ? { threadMessages: item.threadMessages } : {}),
  };
}

/**
 * One response envelope per accepted parse path. Each batch of the corpus
 * run uses the next style, so all six are exercised in a single gate run.
 */
const ENVELOPE_STYLES = [
  "plain-results-object",
  "fenced-legacy-array",
  "think-prefixed-object",
  "column-format",
  "messages-alias-key",
  "fenced-items-object",
] as const;

function renderEnvelope(
  style: (typeof ENVELOPE_STYLES)[number],
  answers: TriageFixtureAnswer[],
): string {
  switch (style) {
    case "plain-results-object":
      return JSON.stringify({ results: answers });
    case "fenced-legacy-array":
      return `\`\`\`json\n${JSON.stringify(answers, null, 2)}\n\`\`\``;
    case "think-prefixed-object":
      return `<think>Sorting each message into the taxonomy.</think>\n${JSON.stringify({ results: answers })}`;
    case "column-format":
      return JSON.stringify({
        classification: answers.map((a) => a.classification),
        urgency: answers.map((a) => a.urgency),
        confidence: answers.map((a) => a.confidence),
        reasoning: answers.map((a) => a.reasoning),
        suggestedResponse: answers.map((a) => a.suggestedResponse ?? null),
      });
    case "messages-alias-key":
      return JSON.stringify({ messages: answers });
    case "fenced-items-object":
      return `\`\`\`\n${JSON.stringify({ items: answers })}\n\`\`\``;
  }
}

interface FixtureModelStats {
  calls: number;
  envelopesUsed: string[];
}

/**
 * Minimal runtime for the classifier: `useModel` answers from fixtures by
 * matching the prompt's own `text:` lines back to corpus items; `getService`
 * returns null so `resolveOptimizedPromptForRuntime` falls back to the
 * baseline instructions (no OptimizedPromptService in the bench).
 */
function createFixtureModelRuntime(): {
  runtime: IAgentRuntime;
  stats: FixtureModelStats;
} {
  const byPromptText = new Map<string, TriageFixtureAnswer>();
  for (const item of TRIAGE_CORPUS) {
    const fixture = TRIAGE_FIXTURES[item.id];
    if (!fixture) {
      throw new Error(
        `[lifeops-quality] no fixture for corpus item ${item.id}`,
      );
    }
    byPromptText.set(promptScalar(item.text), fixture);
  }

  const stats: FixtureModelStats = { calls: 0, envelopesUsed: [] };
  const runtime = {
    getService: () => null,
    useModel: async (_type: string, params: { prompt: string }) => {
      const marker = "Messages to classify:";
      const markerIndex = params.prompt.indexOf(marker);
      if (markerIndex === -1) {
        throw new Error(
          "[lifeops-quality] prompt is missing the messages section",
        );
      }
      const answers: TriageFixtureAnswer[] = [];
      for (const line of params.prompt.slice(markerIndex).split("\n")) {
        if (!line.startsWith("  text: ")) continue;
        const text = line.slice("  text: ".length);
        const fixture = byPromptText.get(text);
        if (!fixture) {
          throw new Error(
            `[lifeops-quality] prompt text not in corpus: ${text.slice(0, 80)}`,
          );
        }
        answers.push(fixture);
      }
      if (answers.length === 0) {
        throw new Error("[lifeops-quality] prompt carried no messages");
      }
      const style = ENVELOPE_STYLES[stats.calls % ENVELOPE_STYLES.length];
      if (!style) {
        throw new Error("[lifeops-quality] envelope style rotation broke");
      }
      stats.calls += 1;
      stats.envelopesUsed.push(style);
      return renderEnvelope(style, answers);
    },
  };
  return { runtime: runtime as unknown as IAgentRuntime, stats };
}

/** Runtime whose model returns a fixed raw payload (fail-closed probes). */
function createRawResponseRuntime(raw: string | Error): IAgentRuntime {
  const runtime = {
    getService: () => null,
    useModel: async () => {
      if (raw instanceof Error) throw raw;
      return raw;
    },
  };
  return runtime as unknown as IAgentRuntime;
}

const FAIL_CLOSED_MESSAGES: InboundMessage[] = TRIAGE_CORPUS.slice(0, 2).map(
  (item, index) => toInboundMessage(item, index),
);

describe("lifeops-quality: inbox triage precision/recall gate (#10723)", () => {
  const persisted: Record<string, unknown> = {};

  afterEach(() => {
    if (Object.keys(persisted).length === 0) return;
    fs.mkdirSync(fileURLToPath(new URL("../results/", import.meta.url)), {
      recursive: true,
    });
    fs.writeFileSync(
      RESULTS_PATH,
      `${JSON.stringify(
        { generatedAt: new Date().toISOString(), ...persisted },
        null,
        2,
      )}\n`,
    );
  });

  it("classifies the committed corpus through the real parse/validate path within budgets", async () => {
    const { runtime, stats } = createFixtureModelRuntime();
    const messages = TRIAGE_CORPUS.map((item, index) =>
      toInboundMessage(item, index),
    );
    const results = await classifyMessages(runtime, messages, {
      config: { prioritySenders: [...PRIORITY_SENDERS] },
      ownerContext:
        "Owner is a startup founder; family and Dana Reyes are top priority.",
    });

    // Every batch made it through the real parser — a dropped row is a
    // pipeline failure, not a scoring event.
    expect(results).toHaveLength(TRIAGE_CORPUS.length);
    expect(stats.envelopesUsed).toEqual([...ENVELOPE_STYLES]);

    // Value normalization is part of the surface: ur-01's fixture answers
    // " URGENT "/"HIGH", nr-01's confidence is the string "0.93".
    const ur01 = results[TRIAGE_CORPUS.findIndex((i) => i.id === "ur-01")];
    expect(ur01?.classification).toBe("urgent");
    expect(ur01?.urgency).toBe("high");
    const nr01 = results[TRIAGE_CORPUS.findIndex((i) => i.id === "nr-01")];
    expect(nr01?.confidence).toBe(0.93);

    const score: TriageScore = scoreTriage(
      TRIAGE_CLASSES,
      TRIAGE_CORPUS.map((item) => item.gold),
      results.map((result) => result.classification),
    );
    persisted.budgets = budgets.triage;
    persisted.score = score;
    persisted.envelopesUsed = stats.envelopesUsed;

    const floors = budgets.triage;
    console.info(
      `[triage] accuracy=${score.accuracy.toFixed(4)} (floor ${floors.minAccuracy}) macroF1=${score.macroF1.toFixed(4)} (floor ${floors.minMacroF1})`,
    );
    for (const label of TRIAGE_CLASSES) {
      const cls = score.perClass[label];
      const floor = floors.perClass[label];
      if (!cls || !floor) {
        throw new Error(`[lifeops-quality] missing class ${label}`);
      }
      console.info(
        `[triage] ${label}: precision=${cls.precision.toFixed(4)} (floor ${floor.minPrecision}) recall=${cls.recall.toFixed(4)} (floor ${floor.minRecall})`,
      );
      if (
        cls.precision > floor.minPrecision + 0.05 ||
        cls.recall > floor.minRecall + 0.05
      ) {
        console.info(
          `[triage] ${label} beats its floors with headroom — consider ratcheting budgets.json`,
        );
      }
      expect(cls.precision, `${label} precision`).toBeGreaterThanOrEqual(
        floor.minPrecision,
      );
      expect(cls.recall, `${label} recall`).toBeGreaterThanOrEqual(
        floor.minRecall,
      );
    }
    expect(score.accuracy, "accuracy").toBeGreaterThanOrEqual(
      floors.minAccuracy,
    );
    expect(score.macroF1, "macro F1").toBeGreaterThanOrEqual(floors.minMacroF1);

    // Recorded-baseline contract: the pipeline is fully deterministic, so
    // the measured run must reproduce baseline.json exactly. Editing the
    // corpus/fixtures requires re-recording the baseline in the same change.
    expect(score.total).toBe(baseline.triage.corpusSize);
    expect(score.correct).toBe(baseline.triage.correct);
    expect(score.accuracy).toBeCloseTo(baseline.triage.accuracy, 10);
    expect(score.macroF1).toBeCloseTo(baseline.triage.macroF1, 10);
    for (const label of TRIAGE_CLASSES) {
      const measured = score.perClass[label];
      const recorded =
        baseline.triage.perClass[
          label as keyof typeof baseline.triage.perClass
        ];
      expect(measured?.precision, `${label} baseline precision`).toBeCloseTo(
        recorded.precision,
        10,
      );
      expect(measured?.recall, `${label} baseline recall`).toBeCloseTo(
        recorded.recall,
        10,
      );
    }
  });

  it("fails closed on a pipe-echoed enum instead of guessing a class", async () => {
    const runtime = createRawResponseRuntime(
      JSON.stringify({
        results: [
          {
            classification: "urgent|ignore",
            urgency: "high",
            confidence: 0.9,
            reasoning: "echoed the option list",
          },
          {
            classification: "ignore",
            urgency: "low",
            confidence: 0.9,
            reasoning: "ok",
          },
        ],
      }),
    );
    await expect(
      classifyMessages(runtime, FAIL_CLOSED_MESSAGES, {}),
    ).rejects.toThrow(InboxTriageClassificationError);
  });

  it("fails closed when the model omits a message", async () => {
    const runtime = createRawResponseRuntime(
      JSON.stringify({
        results: [
          {
            classification: "ignore",
            urgency: "low",
            confidence: 0.9,
            reasoning: "only one row for two messages",
          },
        ],
      }),
    );
    await expect(
      classifyMessages(runtime, FAIL_CLOSED_MESSAGES, {}),
    ).rejects.toThrow("omitted one or more messages");
  });

  it("fails closed on an out-of-range confidence", async () => {
    const runtime = createRawResponseRuntime(
      JSON.stringify({
        results: FAIL_CLOSED_MESSAGES.map(() => ({
          classification: "info",
          urgency: "low",
          confidence: 1.5,
          reasoning: "confidence out of range",
        })),
      }),
    );
    await expect(
      classifyMessages(runtime, FAIL_CLOSED_MESSAGES, {}),
    ).rejects.toThrow("invalid structured fields");
  });

  it("fails closed on prose output instead of regex-slicing JSON out of it", async () => {
    const runtime = createRawResponseRuntime(
      "Sure! The first message is spam and the second needs a reply.",
    );
    await expect(
      classifyMessages(runtime, FAIL_CLOSED_MESSAGES, {}),
    ).rejects.toThrow(InboxTriageClassificationError);
  });

  it("fails closed when the model call itself rejects", async () => {
    const runtime = createRawResponseRuntime(new Error("provider timeout"));
    await expect(
      classifyMessages(runtime, FAIL_CLOSED_MESSAGES, {}),
    ).rejects.toThrow("Inbox classification model call failed.");
  });
});
