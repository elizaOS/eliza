/** Local measurement only (not committed): sends every turn of an exported room
 * through the real Stage 1 and planner code with a scripted model, then through
 * the runtime's model dispatch with reference substitution on, and records the
 * requests a provider would receive. Runs unchanged at the pin and on the branch. */
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Memory,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { it, vi } from "vitest";
import {
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../__tests__/stage1/fixtures.ts";
import { canonicalEvaluatorMessages } from "../services/evaluator-transcript";
import { historyRetentionEvaluator } from "../services/history-retention.ts";

vi.mock("../services/message/addressing", async (original) => ({
  ...(await original<typeof import("../services/message/addressing")>()),
  resolveStage1SenderRole: async () => "OWNER",
}));

const ROOM = process.env.CTX_REPLAY_ROOM;
const DB = process.env.CTX_REPLAY_DB;
const OUT = process.env.CTX_REPLAY_OUT;
const SHAPES = process.env.CTX_REPLAY_SHAPES;
const STABLE = process.env.CTX_REPLAY_STABLE === "1";
/** The room export's clock runs this far ahead of the model-call log's. */
const SHIFT = process.env.CTX_REPLAY_SHIFT_MS
  ? Number(process.env.CTX_REPLAY_SHIFT_MS)
  : 8 * 3_600_000;

type Wire = Record<string, unknown>;

it.skipIf(!ROOM)(
  "records the requests of a replayed room",
  async () => {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    let database:
      | {
          query: (sql: string) => Promise<{ rows: unknown[] }>;
          close: () => Promise<void>;
        }
      | undefined;
    let scratch: string | undefined;
    if (DB) {
      scratch = mkdtempSync(join(tmpdir(), "ctx-requests-"));
      cpSync(DB, join(scratch, "db"), { recursive: true });
      for (const stale of ["postmaster.pid", "eliza-pglite.lock"])
        rmSync(join(scratch, "db", stale), { force: true });
      const { PGlite } = await import("@electric-sql/pglite");
      const { vector } = await import("@electric-sql/pglite/vector");
      const { fuzzystrmatch } = await import(
        "@electric-sql/pglite/contrib/fuzzystrmatch"
      );
      const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
      database = (await PGlite.create({
        dataDir: join(scratch, "db"),
        extensions: { vector, fuzzystrmatch, pg_trgm },
      })) as never;
    }
    const rows = JSON.parse(readFileSync(String(ROOM), "utf8")) as Memory[];
    const agentId = rows.find((row) => row.agentId)?.agentId as string;
    const shapes = SHAPES
      ? (JSON.parse(readFileSync(SHAPES, "utf8")) as {
          at: number;
          planned: boolean;
        }[])
      : [];
    const planned = (at: number) => {
      const near = shapes.reduce<{ at: number; planned: boolean } | undefined>(
        (best, shape) =>
          !best || Math.abs(shape.at - at) < Math.abs(best.at - at)
            ? shape
            : best,
        undefined,
      );
      return near && Math.abs(near.at - at) < 120_000 ? near.planned : true;
    };

    const real = createSQLiteTestRuntime({
      character: {
        name: "Alpha",
        bio: "t",
        settings: {
          ELIZA_SECRET_SWAP_ENABLED: "true",
          ...(STABLE ? { ELIZA_SECRET_SWAP_STABLE_REFERENCES: "true" } : {}),
        },
      } as never,
      logLevel: "fatal",
    });
    const wire: Wire[] = [];
    for (const type of [ModelType.RESPONSE_HANDLER, ModelType.ACTION_PLANNER])
      real.registerModel(
        type,
        async (_runtime, params) => {
          wire.push(JSON.parse(JSON.stringify(params)) as Wire);
          return "ok" as never;
        },
        "capture",
      );

    const records: unknown[] = [];
    let turn = 0;
    for (let index = 1; index < rows.length; index++) {
      if (rows[index].entityId === agentId || !rows[index].content?.text)
        continue;
      // The stored row carries what the turn wrote afterwards (its outcome and
      // recovery records); the arriving message had none of it.
      const { chatIdempotency: _later, ...arrived } = rows[index]
        .content as Record<string, unknown>;
      const current = { ...rows[index], content: arrived } as Memory;
      turn++;
      const at = Number(current.createdAt) - SHIFT;
      const prior = canonicalEvaluatorMessages(
        rows.slice(0, index),
        agentId as never,
      );
      const plans = planned(at);
      const runtime = makeRuntime(
        plans
          ? [
              stage1Response({ contexts: ["general"] }),
              {
                text: "",
                toolCalls: [
                  { id: "reply", name: "REPLY", arguments: { text: "Done." } },
                ],
              },
            ]
          : [stage1Response({ contexts: ["simple"], replyText: "Done." })],
      );
      Object.assign(runtime, {
        agentId,
        evaluators: [historyRetentionEvaluator],
        adapter: {
          db: {
            execute: async (statement: {
              queryChunks: Array<{ value: string[] }>;
            }) => {
              if (!database) throw new Error("no database");
              return database.query(
                statement.queryChunks
                  .map((chunk) => chunk.value.join(""))
                  .join(""),
              );
            },
          },
        },
      });
      runtime.getCache = async () => undefined;
      const state = makeState();
      state.data.providers = {
        RECENT_MESSAGES: { data: { recentMessages: prior } },
      };
      runtime.composeState = vi.fn(async () => structuredClone(state));
      try {
        await runStage1({ runtime, message: current, state });
      } catch (error) {
        records.push({ turn, at, error: String(error).slice(0, 200) });
      }
      const calls = useModelCalls(runtime) as [string, Wire][];
      await runWithTrajectoryContext(
        { roomId: String(current.roomId) } as never,
        async () => {
          for (const [position, [type, params]] of calls.entries()) {
            const before = wire.length;
            const request: Wire = {};
            for (const [key, value] of Object.entries(params))
              if (
                typeof value !== "function" &&
                !["stream", "signal", "abortSignal"].includes(key)
              )
                request[key] = value;
            await real.useModel(type as never, request as never);
            const sent = wire[before];
            if (!sent) continue;
            const messages = Array.isArray(sent.messages)
              ? (sent.messages as { role?: string; content?: unknown }[])
              : [];
            const lead =
              messages[0]?.role === "system" ? messages[0] : undefined;
            const system =
              typeof sent.system === "string"
                ? sent.system
                : typeof lead?.content === "string"
                  ? lead.content
                  : "";
            const tools = Array.isArray(sent.tools)
              ? (sent.tools as Wire[])
              : [];
            records.push({
              turn,
              at: at + position * 4000,
              ms: 3000,
              type,
              planned: plans,
              prior: prior.length,
              system,
              messages: lead ? messages.slice(1) : messages,
              tools: tools.map((tool) => ({
                name: String(
                  tool.name ?? (tool.function as Wire | undefined)?.name ?? "",
                ),
                chars: JSON.stringify(tool).length,
                hash: createHash("sha256")
                  .update(JSON.stringify(tool))
                  .digest("hex")
                  .slice(0, 12),
              })),
              ...(process.env.CTX_REPLAY_FULL_TOOLS === "1"
                ? { toolsFull: tools }
                : {}),
              maxTokens:
                sent.omitMaxTokens === true ? undefined : sent.maxTokens,
            });
          }
        },
      );
    }
    await real.stop();
    await database?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (OUT)
      writeFileSync(
        OUT,
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        { mode: 0o600 },
      );
    const errors = records.filter(
      (record) => (record as { error?: string }).error,
    );
    console.log(
      JSON.stringify({
        turns: turn,
        requests: records.length - errors.length,
        errors: errors.length,
        firstError: errors[0],
      }),
    );
  },
  600_000,
);
