/**
 * Keyless per-plugin e2e for `@elizaos/plugin-birdclaw` (issue #8801, cluster 1
 * of #15759).
 *
 * Drives the `BIRDCLAW` umbrella action's `search` op end-to-end against a fake
 * birdclaw CLI binary written to a temp dir and pointed at via `BIRDCLAW_BIN`.
 * The real BirdclawService spawns it (execFile) exactly as it would the real
 * `birdclaw` binary — `--version` for the availability probe, `db stats --json`
 * at service start, and `search tweets <query> … --json` for the search — so
 * this exercises the real action → service → subprocess → JSON-parse path with
 * zero credentials and no live archive. The fake binary appends every argv it
 * receives to an invocation log the final check reads, proving the search
 * actually reached the CLI seam with the planned query.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulActionData,
} from "../_helpers/effect-assertions.ts";

const BIRDCLAW = "BIRDCLAW";
const SEARCH_QUERY = "local-first";

type R = AgentRuntime & {
  setSetting?: (k: string, v: string, secret?: boolean) => void;
  scenarioLlmFixtures?: {
    register: (...f: Array<Record<string, unknown>>) => void;
  };
};

let birdclawTmpDir: string | undefined;
/** Path the fake CLI appends its argv to — read by the effect check. */
let birdclawInvocationLog: string | undefined;

/**
 * A `/bin/sh` stand-in for the birdclaw CLI. Answers the three commands the
 * service issues on the search path with the CLI's `--json` envelope shapes,
 * and logs every invocation so the effect check can prove the real spawn
 * happened with the planned query. The log path is baked in (not passed via
 * env) because BirdclawService.spawnEnv only forwards a PATH/HOME allowlist.
 */
function fakeBirdclawScript(logPath: string): string {
  return [
    "#!/bin/sh",
    `echo "$@" >> "${logPath}"`,
    'if [ "$1" = "--version" ]; then printf "birdclaw 0.7.0-scenario\\n"; exit 0; fi',
    'if [ "$1" = "db" ] && [ "$2" = "stats" ]; then',
    '  printf \'%s\' \'{"paths":{"rootDir":"/scenario/birdclaw"},"stats":{"home":2,"mentions":1,"dms":0,"needsReply":1,"inbox":1},"transport":{"installed":true,"availableTransport":"xurl","statusText":"connected"}}\'',
    "  exit 0",
    "fi",
    'if [ "$1" = "search" ] && [ "$2" = "tweets" ]; then',
    '  q="$3"',
    '  case "$q" in --*) q="" ;; esac',
    '  printf \'[{"id":"t1","text":"archived thread about %s and sync engines","createdAt":"2026-01-02T00:00:00.000Z","author":{"handle":"birdwatcher","displayName":"Bird Watcher"},"likeCount":5,"liked":true,"bookmarked":false,"isReplied":false,"kind":"tweet"},{"id":"t2","text":"a second %s note","createdAt":"2026-01-01T00:00:00.000Z","author":{"handle":"birdwatcher","displayName":"Bird Watcher"},"likeCount":2,"liked":false,"bookmarked":true,"isReplied":false,"kind":"tweet"}]\' "$q" "$q"',
    "  exit 0",
    "fi",
    "printf '{}'",
    "exit 0",
    "",
  ].join("\n");
}

export default scenario({
  lane: "pr-deterministic",
  id: "birdclaw.search-archive",
  title: "Birdclaw: search the local Twitter/X archive via a fake CLI",
  domain: "birdclaw",
  tags: ["smoke", "birdclaw", "archive"],
  description:
    "Searches the birdclaw local Twitter/X archive through the BIRDCLAW action against a fake birdclaw CLI binary the real service spawns — keyless, no live archive.",

  requires: { plugins: ["@elizaos/plugin-birdclaw"] },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "birdclaw-fake-cli-and-fixtures",
      apply: async (ctx) => {
        const runtime = ctx.runtime as R;
        birdclawTmpDir = mkdtempSync(join(tmpdir(), "birdclaw-scenario-"));
        birdclawInvocationLog = join(birdclawTmpDir, "invocations.log");
        const binPath = join(birdclawTmpDir, "birdclaw");
        writeFileSync(binPath, fakeBirdclawScript(birdclawInvocationLog), {
          mode: 0o755,
        });

        // Point the service at the fake binary BEFORE the plugin registers, so
        // its start-time availability probe (`--version`) resolves installed
        // and the action's validate() offers BIRDCLAW to the planner.
        runtime.setSetting?.("BIRDCLAW_BIN", binPath);

        runtime.scenarioLlmFixtures?.register(
          {
            name: "birdclaw-stage1",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: (v: string) =>
                v.includes("archive") || v.includes("twitter"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              contexts: ["archive", "social"],
              intents: ["search my twitter archive"],
              replyText: "",
              threadOps: [],
              candidateActionNames: [BIRDCLAW],
            },
            times: 1,
          },
          {
            name: "birdclaw-planner",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.ACTION_PLANNER &&
              call.toolNames.includes(BIRDCLAW),
            response: {
              text: "",
              thought: "Search the birdclaw archive.",
              messageToUser: "",
              completed: true,
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call-birdclaw",
                  name: BIRDCLAW,
                  type: "function",
                  arguments: {
                    action: "search",
                    query: SEARCH_QUERY,
                    resource: "home",
                  },
                },
              ],
            },
            times: 1,
          },
          {
            name: "birdclaw-decision",
            match: (call: { modelType: string; toolNames: string[] }) =>
              call.modelType === ModelType.RESPONSE_HANDLER &&
              !call.toolNames.includes("HANDLE_RESPONSE"),
            response: {
              success: true,
              decision: "FINISH",
              thought:
                "Reported the archive search results; nothing more to do.",
              messageToUser: "Here's what I found in your birdclaw archive.",
            },
            times: 1,
          },
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "birdclaw-cleanup-tmp",
      apply: () => {
        if (birdclawTmpDir && existsSync(birdclawTmpDir)) {
          rmSync(birdclawTmpDir, { recursive: true, force: true });
        }
        birdclawTmpDir = undefined;
        birdclawInvocationLog = undefined;
        return undefined;
      },
    },
  ],

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Birdclaw" },
  ],

  turns: [
    {
      kind: "message",
      name: "search",
      text: "Search my twitter archive for that local-first sync engines thread.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === BIRDCLAW);
        if (!call) {
          return `Expected ${BIRDCLAW} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${BIRDCLAW} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: BIRDCLAW,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the search really spawned the birdclaw CLI with
      // the planned query and surfaced the parsed archive rows — not just "the
      // handler returned success". The invocation log proves the subprocess
      // received `search tweets local-first …`, and result.data carries the
      // parsed tweets whose text echoes the searched query.
      type: "custom",
      name: "birdclaw-search-effect",
      predicate: (ctx) => {
        if (!birdclawInvocationLog || !existsSync(birdclawInvocationLog)) {
          return "fake birdclaw CLI was never spawned (no invocation log written)";
        }
        const log = readFileSync(birdclawInvocationLog, "utf8");
        if (!/search tweets/.test(log)) {
          return `the birdclaw CLI never received a 'search tweets' command; log:\n${log}`;
        }
        if (!log.includes(SEARCH_QUERY)) {
          return `the search never reached the CLI with the planned query "${SEARCH_QUERY}"; log:\n${log}`;
        }
        const data = successfulActionData(ctx, BIRDCLAW);
        if (!data) {
          return `no successful ${BIRDCLAW} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.subaction !== "search") {
          return `expected result.data.subaction "search", saw ${String(data.subaction ?? "(missing)")}`;
        }
        const tweets = data.tweets;
        if (!Array.isArray(tweets) || tweets.length !== 2) {
          return `expected the 2 parsed archive rows in result.data.tweets, saw ${JSON.stringify(tweets ?? null).slice(0, 200)}`;
        }
        const firstText =
          tweets[0] && typeof tweets[0] === "object"
            ? String((tweets[0] as { text?: unknown }).text ?? "")
            : "";
        if (!firstText.includes(SEARCH_QUERY)) {
          return `expected the parsed tweet text to carry the searched query "${SEARCH_QUERY}", saw ${JSON.stringify(firstText).slice(0, 200)}`;
        }
      },
    },
  ],
});
