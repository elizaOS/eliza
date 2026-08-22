/**
 * Keyless per-plugin e2e for `@elizaos/plugin-inbox`.
 *
 * Exercises the cross-channel `INBOX` umbrella action end-to-end with no live
 * credentials and no connected platforms. A "summarize my inboxes" request
 * routes through the INBOX action's `summarize` op, which fans out to each
 * platform's default fetcher (all empty without a connected triage service) and
 * reports a per-platform rollup. Fully deterministic: the action makes no
 * `useModel` call and sets `suppressPostActionContinuation`, so the only model
 * calls are the stage-1 response handler and the action planner.
 */
import {
  describeCalls,
  successfulActionData,
  toRecord,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

const INBOX = "INBOX";

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [],
  },
  id: "inbox.summarize-inboxes",
  title: "Inbox: summarize cross-channel inboxes",
  domain: "inbox",
  tags: ["smoke", "inbox", "connector"],
  description:
    "Summarizes every connected inbox through the INBOX umbrella action — keyless, no live platforms.",

  requires: { plugins: ["@elizaos/plugin-inbox"] },
  isolation: "per-scenario",

  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Inbox" },
  ],

  turns: [
    {
      kind: "action",
      name: "summarize",
      actionName: INBOX,
      options: { parameters: { action: "summarize" } },
      text: "Summarize my inbox across every channel.",
      timeoutMs: 120_000,
      assertTurn: (turn) => {
        const call = turn.actionsCalled.find((a) => a.actionName === INBOX);
        if (!call) {
          return `Expected ${INBOX} but got: ${turn.actionsCalled
            .map((a) => a.actionName)
            .join(", ")}`;
        }
        if (!call.result?.success) {
          return `${INBOX} did not succeed: ${
            call.error?.message ?? call.result?.text ?? "unknown error"
          }`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: INBOX,
      status: "success",
      minCount: 1,
    },
    {
      // Effect proof (#11381): summarize's contract is a per-platform rollup
      // (`summary[]` — one {platform, count, latestAt} entry per fanned-out
      // platform). A handler that "succeeds" without actually fanning out and
      // building the rollup fails here.
      type: "custom",
      name: "inbox-summary-rollup-built",
      predicate: (ctx) => {
        const data = successfulActionData(ctx, INBOX);
        if (!data) {
          return `no successful ${INBOX} result data; calls: ${describeCalls(ctx)}`;
        }
        if (data.subaction !== "summarize") {
          return `expected subaction "summarize", saw ${JSON.stringify(data.subaction)}`;
        }
        const platforms = Array.isArray(data.platforms) ? data.platforms : [];
        const summary = Array.isArray(data.summary) ? data.summary : null;
        if (platforms.length === 0 || !summary) {
          return `expected non-empty platforms + summary rollup, saw ${JSON.stringify(data).slice(0, 200)}`;
        }
        if (summary.length !== platforms.length) {
          return `expected one summary entry per platform (${platforms.length}), saw ${summary.length}`;
        }
        for (const entry of summary) {
          const record = toRecord(entry);
          if (
            typeof record?.platform !== "string" ||
            typeof record?.count !== "number"
          ) {
            return `summary entry missing {platform, count}: ${JSON.stringify(entry).slice(0, 120)}`;
          }
        }
      },
    },
  ],
});
