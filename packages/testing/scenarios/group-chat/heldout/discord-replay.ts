/**
 * Converts pinned Discord-Dialogues ChatML rows into replay decision points.
 * The source contains two-author chains, so every observed next turn yields a
 * SPEAK row for its author seat and a SILENT row for the other seat. These are
 * observational pseudo-labels for distribution-shift comparisons, not claims
 * about an objectively correct intervention.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupChatCorpusError } from "../_errors.ts";

export const DISCORD_REVISION = "a8b2294bd5b4acfe4ce537b688e7eee111c50fe2";
const DATASET = "mookiezi/Discord-Dialogues";
const TOTAL_ROWS = 7_300_966;
const SAMPLE_ROWS = 24;
const SAMPLE_SEED = "eliza-discord-replay-v1";

type Seat = "participant_a" | "participant_b";
type ReplayTurn = { speaker: Seat; text: string };
export type DiscordReplayPoint = {
  schemaVersion: 1;
  conversationId: string;
  turns: ReplayTurn[];
  decisionPoint: number;
  targetSpeaker: Seat;
  label: "speak" | "silent";
  labelKind: "observed-next-speaker" | "observed-other-speaker";
  personaHint: null;
  sourceTrace: {
    dataset: typeof DATASET;
    revision: typeof DISCORD_REVISION;
    split: "train";
    rowIndex: number;
    nextTurnIndex: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDiscordChatml(text: string): ReplayTurn[] {
  const endText = text.endsWith("<|end_of_text|>")
    ? text.slice(0, -"<|end_of_text|>".length)
    : text;
  const pattern = /<\|im_start\|>(user|assistant)\n([\s\S]*?)<\|im_end\|>/g;
  const turns: ReplayTurn[] = [];
  let cursor = 0;
  for (const match of endText.matchAll(pattern)) {
    if (match.index !== cursor) {
      throw groupChatCorpusError({
        code: "DISCORD_REPLAY_INVALID_CHATML",
        message: "Discord replay ChatML has an unconsumed segment",
        context: { cursor },
      });
    }
    const role = match[1];
    const message = match[2];
    if (!message.trim())
      throw groupChatCorpusError({
        code: "DISCORD_REPLAY_EMPTY_TURN",
        message: "Discord replay ChatML contains an empty turn",
      });
    turns.push({
      speaker: role === "user" ? "participant_a" : "participant_b",
      text: message,
    });
    cursor = match.index + match[0].length;
    if (endText[cursor] === "\n") cursor += 1;
  }
  if (cursor !== endText.length || turns.length < 2) {
    throw groupChatCorpusError({
      code: "DISCORD_REPLAY_INCOMPLETE_CHATML",
      message: "Discord replay ChatML is not a complete multi-turn chain",
      context: { consumedCharacters: cursor, totalCharacters: endText.length },
    });
  }
  return turns;
}

function otherSeat(seat: Seat): Seat {
  return seat === "participant_a" ? "participant_b" : "participant_a";
}

export function convertDiscordRow(args: {
  rowIndex: number;
  text: string;
}): DiscordReplayPoint[] {
  const turns = parseDiscordChatml(args.text);
  const conversationId = createHash("sha256")
    .update(`${DISCORD_REVISION}:train:${args.rowIndex}`)
    .digest("hex");
  const points: DiscordReplayPoint[] = [];
  for (
    let nextTurnIndex = 1;
    nextTurnIndex < turns.length;
    nextTurnIndex += 1
  ) {
    const observedSeat = turns[nextTurnIndex].speaker;
    const completePrefix = turns.slice(0, nextTurnIndex);
    const sourceTrace: DiscordReplayPoint["sourceTrace"] = {
      dataset: DATASET,
      revision: DISCORD_REVISION,
      split: "train" as const,
      rowIndex: args.rowIndex,
      nextTurnIndex,
    };
    points.push({
      schemaVersion: 1,
      conversationId,
      turns: completePrefix,
      decisionPoint: completePrefix.length - 1,
      targetSpeaker: observedSeat,
      label: "speak",
      labelKind: "observed-next-speaker",
      personaHint: null,
      sourceTrace,
    });
    points.push({
      schemaVersion: 1,
      conversationId,
      turns: completePrefix,
      decisionPoint: completePrefix.length - 1,
      targetSpeaker: otherSeat(observedSeat),
      label: "silent",
      labelKind: "observed-other-speaker",
      personaHint: null,
      sourceTrace,
    });
  }
  return points;
}

export function deterministicDiscordOffsets(): number[] {
  const offsets = new Set<number>();
  let counter = 0;
  while (offsets.size < SAMPLE_ROWS) {
    const digest = createHash("sha256")
      .update(`${SAMPLE_SEED}:${counter}`)
      .digest();
    offsets.add(digest.readUInt32BE(0) % TOTAL_ROWS);
    counter += 1;
  }
  return [...offsets].sort((left, right) => left - right);
}

async function fetchRow(
  rowIndex: number,
): Promise<{ rowIndex: number; text: string }> {
  const query = new URLSearchParams({
    dataset: DATASET,
    config: "default",
    split: "train",
    offset: String(rowIndex),
    length: "1",
  });
  const response = await fetch(
    `https://datasets-server.huggingface.co/rows?${query}`,
  );
  if (!response.ok)
    throw groupChatCorpusError({
      code: "DISCORD_REPLAY_FETCH_FAILED",
      message: "Discord replay source row request failed",
      context: { rowIndex, status: response.status },
    });
  const revision = response.headers.get("x-revision");
  if (revision !== DISCORD_REVISION) {
    throw groupChatCorpusError({
      code: "DISCORD_REPLAY_REVISION_MISMATCH",
      message: "Discord replay source revision does not match the pinned input",
      context: { rowIndex, expected: DISCORD_REVISION, actual: revision },
    });
  }
  const payload: unknown = await response.json();
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.rows) ||
    payload.rows.length !== 1
  ) {
    throw groupChatCorpusError({
      code: "DISCORD_REPLAY_INVALID_RESPONSE",
      message: "Discord replay source response has invalid rows",
      context: { rowIndex },
    });
  }
  const wrapper = payload.rows[0];
  if (
    !isRecord(wrapper) ||
    !isRecord(wrapper.row) ||
    typeof wrapper.row.text !== "string"
  ) {
    throw groupChatCorpusError({
      code: "DISCORD_REPLAY_MISSING_TEXT",
      message: "Discord replay source response has no text",
      context: { rowIndex },
    });
  }
  return { rowIndex, text: wrapper.row.text };
}

export async function generateDiscordReplay(
  outputFile?: string,
): Promise<string> {
  const offsets = deterministicDiscordOffsets();
  const rows = await Promise.all(offsets.map((rowIndex) => fetchRow(rowIndex)));
  const points = rows.flatMap(convertDiscordRow);
  const target =
    outputFile ??
    path.join(tmpdir(), "eliza-group-chat-eval", "discord-replay-v1.jsonl");
  await mkdir(path.dirname(target), { recursive: true });
  const body = `${points.map((point) => JSON.stringify(point)).join("\n")}\n`;
  await writeFile(target, body, "utf8");
  const hash = createHash("sha256").update(body).digest("hex");
  await writeFile(
    `${target}.manifest.json`,
    `${JSON.stringify({ dataset: DATASET, revision: DISCORD_REVISION, license: "Apache-2.0", labelSemantics: "observed next-speaker pseudo-labels", sampledRowOffsets: offsets, replayRows: points.length, outputSha256: hash }, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `[discord-replay] wrote ${points.length} decision rows to ${target} (${hash})\n`,
  );
  return target;
}

if (import.meta.main) await generateDiscordReplay(process.argv[2]);
