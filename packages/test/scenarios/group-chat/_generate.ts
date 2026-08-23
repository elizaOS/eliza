/**
 * Regenerates the committed group-chat intervention-timing scenarios from the
 * When2Speak corpus (duke-trust-lab/When2Speak, CC BY 4.0, NeurIPS 2026
 * Datasets track). Downloads the dialogue-task test split to a cache
 * directory, stratifies decision points by label and direct-address, samples
 * deterministically, and emits one `.scenario.ts` per sampled row through the
 * `_factory.ts` builder.
 *
 * Run from the repository root:
 *
 *   bun packages/test/scenarios/group-chat/_generate.ts
 *
 * Regeneration is reproducible: the sampler uses a fixed PRNG seed, so the
 * same corpus revision yields byte-identical scenario files. The raw corpus is
 * cached, never committed. Committed scenario text IS corpus-derived content,
 * redistributed under CC BY 4.0 with attribution in this domain's README.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";

const CORPUS_URL =
  "https://huggingface.co/datasets/duke-trust-lab/When2Speak/resolve/main/finetune_test_dialogue.jsonl";
const CACHE_DIR = path.join(tmpdir(), "eliza-group-chat-eval");
const CACHE_FILE = path.join(CACHE_DIR, "when2speak_test_dialogue.jsonl");
const REJECTION_FILE = path.join(
  CACHE_DIR,
  "when2speak_sampling_rejections.json",
);
const OUT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENT_NAME = "ScenarioAgent";
const PRNG_SEED = 0x5eed2026;
/** Scenarios per (label × address) cell: 4 cells → 48 scenarios total. */
const PER_CELL = 12;

type CorpusRow = {
  messages: Array<{ role: string; content: string }>;
};
type CorpusRejection = { row: number; reason: string };

type DecisionPoint = {
  rowIndex: number;
  context: Array<{ speaker: string; text: string }>;
  decisionTurn: { speaker: string; text: string };
  label: "speak" | "silent";
  directlyAddressed: boolean;
  referenceIntervention?: string;
  speakerCount: number;
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitSpeakerTurn(
  content: string,
): { speaker: string; text: string } | null {
  const match = /^(\[?[A-Za-z_]+_?\d*\]?):\s*(.*)$/s.exec(content);
  if (!match) return null;
  const speaker = match[1].replace(/^\[|\]$/g, "");
  const text = match[2].trim();
  if (!speaker || !text) return null;
  return { speaker, text };
}

function substituteAgentName(text: string): string {
  return text.replaceAll("[AGENT]", AGENT_NAME);
}

async function fetchCorpus(): Promise<string> {
  if (existsSync(CACHE_FILE)) {
    return readFile(CACHE_FILE, "utf8");
  }
  await mkdir(CACHE_DIR, { recursive: true });
  console.log(`[generate] downloading ${CORPUS_URL}`);
  const response = await fetch(CORPUS_URL);
  if (!response.ok) {
    throw new ElizaError("When2Speak corpus download failed", {
      code: "WHEN2SPEAK_CORPUS_DOWNLOAD_FAILED",
      context: {
        url: CORPUS_URL,
        status: response.status,
        statusText: response.statusText,
      },
    });
  }
  const body = await response.text();
  await writeFile(CACHE_FILE, body, "utf8");
  return body;
}

function isCorpusRow(value: unknown): value is CorpusRow {
  if (value === null || typeof value !== "object" || !("messages" in value))
    return false;
  const messages = value.messages;
  return (
    Array.isArray(messages) &&
    messages.every(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        "role" in message &&
        typeof message.role === "string" &&
        "content" in message &&
        typeof message.content === "string",
    )
  );
}

function parseDecisionPoints(raw: string): {
  points: DecisionPoint[];
  rejections: CorpusRejection[];
} {
  const points: DecisionPoint[] = [];
  const rejections: CorpusRejection[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      // error-policy:J3 — a malformed corpus line is invalid input to the
      // sampler and is retained in the rejection artifact with its row.
      rejections.push({ row: index + 1, reason: "invalid JSON" });
      continue;
    }
    if (!isCorpusRow(decoded)) {
      rejections.push({ row: index + 1, reason: "unsupported row schema" });
      continue;
    }
    const row = decoded;
    const messages = row.messages;
    if (messages.length < 2) {
      rejections.push({ row: index + 1, reason: "fewer than two messages" });
      continue;
    }
    const labelMessage = messages[messages.length - 1];
    if (labelMessage.role !== "assistant") {
      rejections.push({ row: index + 1, reason: "missing assistant label" });
      continue;
    }
    const labelText = labelMessage.content.trim();
    const label: "speak" | "silent" = labelText === ">" ? "silent" : "speak";

    const contextMessages = messages.slice(0, -1);
    const parsed: Array<{ speaker: string; text: string }> = [];
    let unsupportedReason: string | undefined;
    for (const message of contextMessages) {
      const turn = splitSpeakerTurn(message.content);
      if (!turn) {
        unsupportedReason = "unparseable speaker turn";
        break;
      }
      if (turn.speaker === "AGENT") {
        unsupportedReason = "agent already appears in context";
        break;
      }
      parsed.push({ speaker: turn.speaker, text: turn.text });
    }
    // Rows where the agent already spoke in-context (or the row is
    // unparseable) would need the agent's own turns seeded as agent memories,
    // a different fixture shape; the test split contains none, but guard it.
    if (unsupportedReason || parsed.length < 2) {
      rejections.push({
        row: index + 1,
        reason: unsupportedReason ?? "fewer than two parsed context turns",
      });
      continue;
    }

    const decisionTurn = parsed[parsed.length - 1];
    const context = parsed.slice(0, -1);
    if (context.length === 0) {
      rejections.push({ row: index + 1, reason: "empty seeded context" });
      continue;
    }

    const directlyAddressed = contextMessages.some((message) =>
      message.content.includes("[AGENT]"),
    );
    const speakers = new Set(parsed.map((turn) => turn.speaker));

    points.push({
      rowIndex: index + 1,
      context: context.map((turn) => ({
        speaker: turn.speaker,
        text: substituteAgentName(turn.text),
      })),
      decisionTurn: {
        speaker: decisionTurn.speaker,
        text: substituteAgentName(decisionTurn.text),
      },
      label,
      directlyAddressed,
      ...(label === "speak" ? { referenceIntervention: labelText } : {}),
      speakerCount: speakers.size,
    });
  }
  return { points, rejections };
}

/** Deterministic stratified sample: PER_CELL rows per (label × address) cell,
 * spread across speaker counts within each cell. */
function sampleCells(points: DecisionPoint[]): DecisionPoint[] {
  const rand = mulberry32(PRNG_SEED);
  const cells = new Map<string, DecisionPoint[]>();
  for (const point of points) {
    const key = `${point.label}:${point.directlyAddressed ? "direct" : "none"}`;
    const bucket = cells.get(key) ?? [];
    bucket.push(point);
    cells.set(key, bucket);
  }
  const sampled: DecisionPoint[] = [];
  for (const key of [...cells.keys()].sort()) {
    const bucket = cells.get(key) ?? [];
    // Group by speaker count so the sample spans 2–6+ speaker conversations.
    const bySpeakers = new Map<number, DecisionPoint[]>();
    for (const point of bucket) {
      const group = bySpeakers.get(point.speakerCount) ?? [];
      group.push(point);
      bySpeakers.set(point.speakerCount, group);
    }
    const speakerKeys = [...bySpeakers.keys()].sort((a, b) => a - b);
    const cellSample: DecisionPoint[] = [];
    let cursor = 0;
    while (cellSample.length < PER_CELL) {
      const group = bySpeakers.get(speakerKeys[cursor % speakerKeys.length]);
      if (group && group.length > 0) {
        const pick = Math.floor(rand() * group.length);
        cellSample.push(group.splice(pick, 1)[0]);
      }
      cursor += 1;
      if (cursor > PER_CELL * speakerKeys.length * 4) break;
    }
    if (cellSample.length < PER_CELL) {
      throw new ElizaError("When2Speak sampling cell is undersized", {
        code: "WHEN2SPEAK_SAMPLE_CELL_UNDERSIZED",
        context: { key, usableRows: cellSample.length, requiredRows: PER_CELL },
      });
    }
    sampled.push(...cellSample);
  }
  return sampled;
}

function scenarioFileSource(point: DecisionPoint, ordinal: number): string {
  const address = point.directlyAddressed ? "direct" : "ambient";
  const id = `groupchat.w2s.${point.label}.${address}.${String(ordinal).padStart(3, "0")}`;
  const speakerNoun = point.speakerCount === 1 ? "speaker" : "speakers";
  const title = `Group chat timing: ${point.label.toUpperCase()} (${address} address, ${point.speakerCount} ${speakerNoun})`;
  const config = {
    id,
    title,
    label: point.label,
    directlyAddressed: point.directlyAddressed,
    context: point.context,
    decisionTurn: point.decisionTurn,
    ...(point.referenceIntervention
      ? { referenceIntervention: point.referenceIntervention }
      : {}),
    sourceRow: `When2Speak finetune_test_dialogue.jsonl row ${point.rowIndex}`,
  };
  // Emit the id/title as literals inside the object so the loader's static
  // AST metadata read works; JSON.stringify with indentation produces valid TS.
  const literal = JSON.stringify(config, null, 2);
  const assertion =
    point.label === "silent"
      ? `if (responseLength > 0) {
          return \`label is SILENT — expected no agent response, got \${responseLength} characters\`;
        }`
      : `if (responseLength === 0) {
          return "label is SPEAK — an apt intervention was expected here, got no reply";
        }`;
  const rubric =
    point.label === "silent"
      ? "This is a group chat between human participants. The final message is them talking to each other — no reply from the assistant is expected. Score 1.0 only if the assistant stayed silent; score 0.0 for any reaction, substantive contribution, commentary, agreement, or follow-up question."
      : "This is a group chat between human participants, and the final message is a moment where an assistant participant should genuinely intervene. Score whether the reply is a concise, substantive, on-topic contribution that answers the open question, supplies the missing fact, or synthesizes the thread." +
        (point.referenceIntervention
          ? ` A corpus reference intervention supplies gold flavor, not required wording: ${JSON.stringify(point.referenceIntervention)}`
          : "");
  return `/**
 * Generated by _generate.ts from duke-trust-lab/When2Speak (CC BY 4.0).
 * Do not hand-edit; regenerate with \`bun packages/test/scenarios/group-chat/_generate.ts\`.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  buildGroupChatTimingSetup,
  type GroupChatTimingScenarioConfig,
} from "./_factory.ts";

const config = ${literal} satisfies GroupChatTimingScenarioConfig;
const setup = buildGroupChatTimingSetup(config);

export default scenario({
  lane: "live-only",
  id: ${JSON.stringify(id)},
  title: ${JSON.stringify(title)},
  domain: "group-chat",
  ...setup,
  turns: [
    {
      ...setup.decisionTurn,
      assertResponse(text: string) {
        const responseLength = text.trim().length;
        ${assertion}
      },
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: ${JSON.stringify(`timing:${point.label}`)},
      minimumScore: 0.7,
      rubric: ${JSON.stringify(rubric)},
    },
  ],
});
`;
}

async function main(): Promise<void> {
  const raw = await fetchCorpus();
  const corpusHash = createHash("sha256").update(raw).digest("hex");
  const { points, rejections } = parseDecisionPoints(raw);
  await writeFile(
    REJECTION_FILE,
    `${JSON.stringify({ schema: 1, rejections }, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `[generate] parsed ${points.length} decision points and recorded ${rejections.length} rejected rows at ${REJECTION_FILE} (corpus sha256 ${corpusHash.slice(0, 12)})`,
  );
  const sampled = sampleCells(points);

  // Remove previously generated files so renames/deletions never leave strays.
  for (const entry of await readdir(OUT_DIR)) {
    if (/^groupchat\.w2s\..*\.scenario\.ts$/.test(entry)) {
      await unlink(path.join(OUT_DIR, entry));
    }
  }

  const ordinals = new Map<string, number>();
  for (const point of sampled) {
    const cellKey = `${point.label}:${point.directlyAddressed}`;
    const ordinal = (ordinals.get(cellKey) ?? 0) + 1;
    ordinals.set(cellKey, ordinal);
    const source = scenarioFileSource(point, ordinal);
    const address = point.directlyAddressed ? "direct" : "ambient";
    const fileName = `groupchat.w2s.${point.label}.${address}.${String(ordinal).padStart(3, "0")}.scenario.ts`;
    await writeFile(path.join(OUT_DIR, fileName), source, "utf8");
  }
  console.log(`[generate] wrote ${sampled.length} scenarios to ${OUT_DIR}`);

  // Normalize through the repository formatter so regeneration reproduces the
  // committed files byte-for-byte.
  const format = spawnSync(
    "bunx",
    ["@biomejs/biome", "format", "--write", OUT_DIR],
    { stdio: "inherit" },
  );
  if (format.status !== 0) {
    throw new ElizaError("Failed to format generated When2Speak scenarios", {
      code: "WHEN2SPEAK_FORMAT_FAILED",
      cause: format.error,
      context: { outputDir: OUT_DIR, exitCode: format.status },
    });
  }
}

await main();
