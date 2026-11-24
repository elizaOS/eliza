/** Local measurement only (not committed): replays an exported room through the
 * Stage 1 renderer, turn by turn, with and without the history window. */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContextEvent,
  createContextObject,
  type IAgentRuntime,
  type Memory,
} from "@elizaos/core";
import { it, vi } from "vitest";
import { windowHistoryRetention } from "../runtime/history-retention";
import { canonicalEvaluatorMessages } from "../services/evaluator-transcript";
import { appendPriorDialogueEvents } from "../services/message/dialogue-context";
import { reconcileHistoricalProposalTerminals } from "../services/message/historical-proposal-terminals";
import { projectReviewedHistory } from "../services/message/history-discovery";
import { renderMessageHandlerModelInput } from "../services/message/stage1-input";

vi.mock("../services/message/addressing", async (original) => ({
  ...(await original<typeof import("../services/message/addressing")>()),
  resolveStage1SenderRole: async () => "OWNER",
}));

const ROOM = process.env.CTX_REPLAY_ROOM;
const DB = process.env.CTX_REPLAY_DB;
const OUT = process.env.CTX_REPLAY_OUT;

function estimateTokens(text: string): number {
  let pieces = 0;
  for (const match of text.matchAll(/[A-Za-z]+|[0-9]+|[^A-Za-z0-9\s]+/g)) {
    const run = match[0];
    const code = run.charCodeAt(0);
    if (code >= 48 && code <= 57) pieces += Math.ceil(run.length / 3);
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
      pieces += run.length <= 10 ? 1 : Math.ceil(run.length / 5);
    else pieces += Math.ceil(run.length / 2);
  }
  return Math.round(pieces / 1.1);
}
const lcp = (a: string, b: string) => {
  const end = Math.min(a.length, b.length);
  let at = 0;
  while (at < end && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  return at;
};

function breakSection(text: string, at: number): string {
  if (at >= text.length) return "none";
  const before = text.slice(0, at + 1);
  const marks = [...before.matchAll(/^(runtime:[a-z_]+|# [A-Za-z ]+|\[message_at=|Earlier originals were deferred|Answer the current request)/gm)];
  const last = marks[marks.length - 1]?.[1] ?? "start";
  const tail = text.length - at;
  return `${last.replace("[message_at=", "conversation message")}${tail < 400 ? " (tail)" : ""}`;
}

it.skipIf(!ROOM)("replays a room through Stage 1", async () => {
  let database: { query: (sql: string) => Promise<{ rows: unknown[] }>; close: () => Promise<void> } | undefined;
  let scratch: string | undefined;
  if (DB) {
    scratch = mkdtempSync(join(tmpdir(), "ctx-replay-"));
    cpSync(DB, join(scratch, "db"), { recursive: true });
    for (const stale of ["postmaster.pid", "eliza-pglite.lock"])
      rmSync(join(scratch, "db", stale), { force: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");
    const { fuzzystrmatch } = await import("@electric-sql/pglite/contrib/fuzzystrmatch");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    database = (await PGlite.create({
      dataDir: join(scratch, "db"),
      extensions: { vector, fuzzystrmatch, pg_trgm },
    })) as never;
  }
  const rows = JSON.parse(readFileSync(String(ROOM), "utf8")) as Memory[];
  const agentId = rows.find((row) => row.agentId)?.agentId as string;
  const runtime = {
    agentId,
    character: { name: "Alpha" },
    actions: [],
    adapter: {
      db: {
        execute: async (statement: { queryChunks: Array<{ value: string[] }> }) => {
          if (!database) throw new Error("no database");
          return database.query(statement.queryChunks.map((chunk) => chunk.value.join("")).join(""));
        },
      },
    },
  } as unknown as IAgentRuntime;
  let terminals = 0;
  const contexts = [
    { id: "simple", description: "Answer from supplied context without tools." },
    { id: "general", description: "Conversation and current-room information." },
  ];
  const turns: Array<Record<string, number | string>> = [];
  let previousFull = "";
  let previousWindow = "";
  for (let index = 1; index < rows.length; index++) {
    const current = rows[index];
    if (current.entityId === agentId || !current.content?.text) continue;
    const prior = canonicalEvaluatorMessages(rows.slice(0, index), agentId as never);
    let events: ContextEvent[] = [];
    appendPriorDialogueEvents(
      events,
      runtime,
      {
        values: {},
        text: "",
        data: { providers: { RECENT_MESSAGES: { data: { recentMessages: prior } } } },
      },
      current,
      { includeOwnReplies: true },
    );
    if (database) {
      const before = events.length;
      events = await reconcileHistoricalProposalTerminals(runtime, current, events, prior, {
        background: true,
      });
      terminals = events.length - before;
    }
    events.push(
      {
        id: "current-turn-boundary",
        type: "instruction",
        source: "message-service",
        stable: false,
        content: "Answer the current request.",
      } as ContextEvent,
      {
        id: "current",
        type: "message",
        message: { id: "current", role: "user", content: String(current.content.text) },
      } as ContextEvent,
    );
    const context = createContextObject({
      id: `turn-${index}`,
      metadata: { roomId: current.roomId, messageId: current.id },
      events,
    });
    const scope = {
      agentId,
      roomId: String(current.roomId),
      entityId: String(current.entityId),
      roles: ["OWNER"],
    };
    const options = { directMessage: true, nativeTools: true, progressiveContext: true };
    const full = String(
      renderMessageHandlerModelInput(runtime, context, contexts, options).messages[1]?.content,
    );
    const window = windowHistoryRetention(context, scope, null);
    const checkpoint = window.checkpoint;
    const history = projectReviewedHistory(context, scope, checkpoint);
    if (history && window.windowed) history.windowed = true;
    const windowed = String(
      renderMessageHandlerModelInput(runtime, context, contexts, { ...options, history })
        .messages[1]?.content,
    );
    turns.push({
      at: new Date(Number(current.createdAt)).toISOString(),
      prior: prior.length,
      fullTokens: estimateTokens(full),
      windowTokens: estimateTokens(windowed),
      fullChars: full.length,
      windowChars: windowed.length,
      fullShared: previousFull ? lcp(full, previousFull) : 0,
      windowShared: previousWindow ? lcp(windowed, previousWindow) : 0,
      boundary: checkpoint?.reviewedCount ?? 0,
      windowBreak: previousWindow ? breakSection(windowed, lcp(windowed, previousWindow)) : "",
      fullBreak: previousFull ? breakSection(full, lcp(full, previousFull)) : "",
    });
    previousFull = full;
    previousWindow = windowed;
    if (process.env.CTX_REPLAY_DUMP && index === Number(process.env.CTX_REPLAY_DUMP)) {
      writeFileSync(`${OUT}.full.txt`, full);
      writeFileSync(`${OUT}.window.txt`, windowed);
    }
    if (process.env.CTX_REPLAY_DUMP_ALL) writeFileSync(`${OUT}.turn${turns.length}.txt`, windowed);
  }
  const sum = (key: string) => turns.reduce((total, turn) => total + Number(turn[key]), 0);
  const summary = {
    turns: turns.length,
    fullTokens: sum("fullTokens"),
    windowTokens: sum("windowTokens"),
    saving: 1 - sum("windowTokens") / sum("fullTokens"),
    fullSharedPrefix: sum("fullShared") / sum("fullChars"),
    windowSharedPrefix: sum("windowShared") / sum("windowChars"),
    lastTurn: turns[turns.length - 1],
    terminalsLastTurn: terminals,
  };
  await database?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (OUT) writeFileSync(String(OUT), JSON.stringify({ summary, turns }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
});
