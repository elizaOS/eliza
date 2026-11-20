/**
 * Replays the replies of quint/SentenceEndPathEvidence.qnt through
 * OrchestratorTaskService on a PGlite-backed AgentRuntime. Each reply names a
 * file the session really wrote in a temporary workdir; a sub-agent message
 * goes through the session event handler, and the evidence bundle is built by
 * buildCompletionEvidence, the call the task_complete handler makes.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, ServiceClass } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { createRealTestRuntime } from "./real-runtime.js";

/** One reply of the model (see the model's header for the encodings). */
interface ModelReply {
  mark: number;
  after: number;
  form: number;
  channel: number;
}

/** A reply and whether the model observes the written file. */
interface ModelCase {
  reply: ModelReply;
  observed: boolean;
}

const FILE = "data/apps/echo-fade/index.html";
const CONTENT = "<!doctype html><h1>Echo Fade</h1>\n";
const MARKS = ["", ".", ":", ";", "!", "?", "..."];
const MARK_NAMES = [
  "no mark",
  "a period",
  "a colon",
  "a semicolon",
  "an exclamation mark",
  "a question mark",
  "an ellipsis",
];
const RUNS_ON = 5;

/** The reply text for a model reply, with the path in the given form. */
function replyText(reply: ModelReply, filePath: string): string {
  const named = `${filePath}${MARKS[reply.mark]}`;
  switch (reply.after) {
    case 0:
      return `Done. I created ${named}`;
    case 1:
      return `Done. I created ${named} It loads in the browser.`;
    case 2:
      return `Done. I created ${named}\nIt loads in the browser.`;
    case 3:
      return `Done (the page is ${named}) and it loads.`;
    case 4:
      return `Done. I created "${named}" and it loads.`;
    case RUNS_ON:
      return `Done. I created ${named}bak as a backup.`;
    default:
      throw new Error(`Unknown follower ${reply.after}`);
  }
}

// A file named at the end of a sentence is observed; a longer name is not.
const DEFAULT_CASES: ModelCase[] = [
  { reply: { mark: 0, after: 0, form: 0, channel: 0 }, observed: true },
  { reply: { mark: 1, after: 0, form: 0, channel: 0 }, observed: true },
  { reply: { mark: 1, after: 1, form: 1, channel: 1 }, observed: true },
  { reply: { mark: 2, after: 1, form: 0, channel: 1 }, observed: true },
  { reply: { mark: 3, after: 2, form: 1, channel: 0 }, observed: true },
  { reply: { mark: 4, after: 0, form: 0, channel: 1 }, observed: true },
  { reply: { mark: 5, after: 4, form: 1, channel: 0 }, observed: true },
  { reply: { mark: 6, after: 3, form: 0, channel: 1 }, observed: true },
  { reply: { mark: 1, after: RUNS_ON, form: 0, channel: 0 }, observed: false },
  { reply: { mark: 2, after: RUNS_ON, form: 1, channel: 1 }, observed: false },
];

const casesFile = process.env.ELIZA_SENTENCE_END_PATH_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

let runtime: AgentRuntime;
let cleanup: (() => Promise<void>) | undefined;
let service: OrchestratorTaskService;
let root: string;
let sessionCount = 0;
const previousStateDir = process.env.ELIZA_STATE_DIR;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sentence-end-path-"));
  // The evidence trajectory is written under the state directory.
  process.env.ELIZA_STATE_DIR = join(root, "state");
  ({ runtime, cleanup } = await createRealTestRuntime({
    characterName: "SentenceEndPathEvidenceModel",
    plugins: [
      {
        name: "sentence-end-path-task-service",
        description: "Registers the production orchestrator task service",
        services: [OrchestratorTaskService as unknown as ServiceClass],
      },
    ],
  }));
  const loaded = await runtime.getServiceLoadPromise(
    OrchestratorTaskService.serviceType,
  );
  if (!(loaded instanceof OrchestratorTaskService)) {
    throw new Error("Production orchestrator task service did not start");
  }
  service = loaded;
}, 60_000);

afterAll(async () => {
  await cleanup?.();
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  if (root) rmSync(root, { recursive: true, force: true });
});

/** Runs one model reply through a fresh task session; returns the bundle. */
async function replay(reply: ModelReply) {
  sessionCount += 1;
  const sessionId = `sentence-end-${sessionCount}`;
  const workdir = join(root, `work-${sessionCount}`);
  mkdirSync(workdir);
  const task = await service.createTask({
    title: "Build Echo Fade",
    goal: `Build the Echo Fade page at ${FILE}`,
    acceptanceCriteria: [`${FILE} shows the Echo Fade heading`],
  });
  const attached = await service.attachSession(task.id, {
    sessionId,
    agentType: "codex",
    workdir,
    status: "ready",
  });
  expect(attached).toBe(true);
  // The session writes the file after it started.
  mkdirSync(join(workdir, "data/apps/echo-fade"), { recursive: true });
  writeFileSync(join(workdir, FILE), CONTENT);
  const text = replyText(reply, reply.form === 0 ? FILE : join(workdir, FILE));
  let summary = text;
  if (reply.channel === 1) {
    await service["onSessionEvent"](sessionId, "message", { text });
    summary = "Done.";
  }
  const { bundle } = await service["buildCompletionEvidence"](
    task.id,
    sessionId,
    summary,
  );
  if (!bundle) throw new Error("No completion evidence bundle");
  // The recovery path ran: no write ledger was recorded.
  expect(bundle.ledgerVerifiedFiles).toBeUndefined();
  return { bundle, text };
}

describe("sentence end path evidence model", () => {
  it.each(MARK_NAMES)(
    "replays the model after %s",
    async (name) => {
      const mark = MARK_NAMES.indexOf(name);
      const group = cases.filter((item) => item.reply.mark === mark);
      expect(group.length).toBeGreaterThan(0);
      for (const item of group) {
        const { bundle, text } = await replay(item.reply);
        const label = JSON.stringify({ ...item.reply, text });
        if (item.observed) {
          expect(bundle.fsVerifiedFiles, label).toEqual([FILE]);
          expect(bundle.fsVerifiedFileContents, label).toEqual([
            { path: FILE, content: CONTENT },
          ]);
        } else {
          expect(bundle.fsVerifiedFiles, label).toBeUndefined();
          expect(bundle.fsVerifiedFileContents, label).toBeUndefined();
        }
      }
    },
    120_000,
  );
});
