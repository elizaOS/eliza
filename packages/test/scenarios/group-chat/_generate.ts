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
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CORPUS_URL =
  "https://huggingface.co/datasets/duke-trust-lab/When2Speak/resolve/main/finetune_test_dialogue.jsonl";
const CACHE_DIR = path.join(tmpdir(), "eliza-group-chat-eval");
const CACHE_FILE = path.join(CACHE_DIR, "when2speak_test_dialogue.jsonl");
const OUT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENT_NAME = "ScenarioAgent";
const PRNG_SEED = 0x5eed2026;
/** Scenarios per (label × address) cell: 4 cells → 48 scenarios total. */
const PER_CELL = 12;

type CorpusRow = {
  messages: Array<{ role: string; content: string }>;
};

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
    throw new Error(
      `[generate] corpus download failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = await response.text();
  await writeFile(CACHE_FILE, body, "utf8");
  return body;
}

function parseDecisionPoints(raw: string): DecisionPoint[] {
  const points: DecisionPoint[] = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let row: CorpusRow;
    try {
      row = JSON.parse(line) as CorpusRow;
    } catch {
      // error-policy:J3 — a malformed corpus line is invalid input to the
      // sampler, not a fatal condition for the whole regeneration; it is
      // skipped explicitly and never becomes a fabricated decision point.
      continue;
    }
    const messages = row.messages;
    if (!Array.isArray(messages) || messages.length < 2) continue;
    const labelMessage = messages[messages.length - 1];
    if (labelMessage.role !== "assistant") continue;
    const labelText = labelMessage.content.trim();
    const label: "speak" | "silent" = labelText === ">" ? "silent" : "speak";

    const contextMessages = messages.slice(0, -1);
    const parsed: Array<{ speaker: string; text: string }> = [];
    let agentInContext = false;
    for (const message of contextMessages) {
      const turn = splitSpeakerTurn(message.content);
      if (!turn) {
        agentInContext = true; // treat unparseable rows as unusable
        break;
      }
      if (turn.speaker === "AGENT") {
        agentInContext = true;
        break;
      }
      parsed.push({ speaker: turn.speaker, text: turn.text });
    }
    // Rows where the agent already spoke in-context (or the row is
    // unparseable) would need the agent's own turns seeded as agent memories,
    // a different fixture shape; the test split contains none, but guard it.
    if (agentInContext || parsed.length < 2) continue;

    const decisionTurn = parsed[parsed.length - 1];
    const context = parsed.slice(0, -1);
    if (context.length === 0) continue;

    const directlyAddressed = contextMessages.some((message) =>
      message.content.includes("[AGENT]"),
    );
    const speakers = new Set(parsed.map((turn) => turn.speaker));

    points.push({
      rowIndex: index,
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
  return points;
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
      throw new Error(
        `[generate] cell ${key} has only ${cellSample.length} usable rows (< ${PER_CELL})`,
      );
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
  return `/**
 * Generated by _generate.ts from duke-trust-lab/When2Speak (CC BY 4.0).
 * Do not hand-edit; regenerate with \`bun packages/test/scenarios/group-chat/_generate.ts\`.
 */
import { buildGroupChatTimingScenario } from "./_factory.ts";

export default buildGroupChatTimingScenario(${literal});
`;
}

async function main(): Promise<void> {
  const raw = await fetchCorpus();
  const corpusHash = createHash("sha256").update(raw).digest("hex");
  const points = parseDecisionPoints(raw);
  console.log(
    `[generate] parsed ${points.length} decision points (corpus sha256 ${corpusHash.slice(0, 12)})`,
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
  const format = Bun.spawn(
    ["bunx", "@biomejs/biome", "format", "--write", OUT_DIR],
    { stdout: "inherit", stderr: "inherit" },
  );
  const formatExit = await format.exited;
  if (formatExit !== 0) {
    throw new Error(`[generate] biome format exited with code ${formatExit}`);
  }
}

await main();
