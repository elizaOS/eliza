/**
 * Mind2Web replay through real plugin-browser (#10333 — the external-dataset lane
 * of #9476's deferred list).
 *
 * Today `packages/benchmarks/mind2web/eliza_agent.py` scores Mind2Web by driving
 * the *inference layer* — it never executes the chosen action through
 * plugin-browser. This module closes that gap: it replays a Mind2Web-format
 * action sequence (`CLICK` / `TYPE` / `SELECT` on a target element, the schema in
 * `packages/benchmarks/mind2web/dataset.py`) through the REAL BROWSER command
 * surface via any {@link BrowserCommandExecutor}, and verifies each step's effect
 * by reading observable DOM state back through `get` commands — the same
 * mock-free path the MiniWoB++ and grounding lanes use.
 *
 * Each step carries its own page snapshot (Mind2Web's offline form is a fresh
 * cached HTML per action), served via the `network route` interceptor, so the
 * replay is self-contained and reproducible. The full HF `osunlp/Mind2Web`
 * corpus (multi-GB cached HTML) is loaded only when `MIND2WEB_DATA_DIR` points at
 * a converted task set ({@link loadMind2WebTasks}); without it the lane runs the
 * embedded fixture, exactly like the chromium lanes self-skip without a browser.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceGetMode,
} from "../workspace/browser-workspace-types.js";
import type { BrowserCommandExecutor } from "./types.js";

export type Mind2WebOperation = "CLICK" | "TYPE" | "SELECT";

/** A post-action assertion read back through a real BROWSER `get` command. */
export interface Mind2WebStepCheck {
  getMode: BrowserWorkspaceGetMode;
  selector?: string;
  equals: string;
}

export interface Mind2WebStep {
  actionUid: string;
  /** The page URL this step's snapshot is served at + navigated to. */
  url: string;
  /** The cached page HTML for this step (Mind2Web's per-step snapshot). */
  html: string;
  /** Target element for the operation (a CSS selector). */
  targetSelector: string;
  operation: Mind2WebOperation;
  /** Value for TYPE / SELECT. */
  value?: string;
  /** How to verify the operation landed (real `get` read). */
  check: Mind2WebStepCheck;
}

export interface Mind2WebTask {
  /** Mind2Web `annotation_id`. */
  id: string;
  /** Mind2Web `confirmed_task` — the natural-language goal. */
  instruction: string;
  website: string;
  steps: Mind2WebStep[];
}

export interface Mind2WebStepResult {
  actionUid: string;
  operation: Mind2WebOperation;
  /** The BROWSER command for the operation dispatched without error. */
  executed: boolean;
  /** The post-action `get` read matched the expected value. */
  verified: boolean;
  error: string | null;
}

export interface Mind2WebTaskResult {
  taskId: string;
  website: string;
  engine: string;
  totalSteps: number;
  executedSteps: number;
  verifiedSteps: number;
  /** Step-success rate (executed AND verified) — Mind2Web's step accuracy. */
  stepAccuracy: number;
  /** Whole task solved when every step is executed + verified. */
  success: boolean;
  steps: Mind2WebStepResult[];
}

export interface Mind2WebSuiteReport {
  benchmark: string;
  engine: string;
  source: string;
  tasks: Mind2WebTaskResult[];
  summary: {
    tasks: number;
    solved: number;
    totalSteps: number;
    verifiedSteps: number;
    stepAccuracy: number;
  };
}

function operationCommand(step: Mind2WebStep): BrowserWorkspaceCommand {
  switch (step.operation) {
    case "CLICK":
      return { subaction: "click", selector: step.targetSelector };
    case "TYPE":
      return {
        subaction: "type",
        selector: step.targetSelector,
        value: step.value ?? "",
      };
    case "SELECT":
      return {
        subaction: "select",
        selector: step.targetSelector,
        value: step.value ?? "",
      };
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/**
 * Replay one Mind2Web task through the executor: for each step, route + navigate
 * to the step's snapshot, execute the operation through the real BROWSER command
 * surface, and verify the effect via a real `get` read.
 */
export async function replayMind2WebTask(
  executor: BrowserCommandExecutor,
  task: Mind2WebTask,
): Promise<Mind2WebTaskResult> {
  const steps: Mind2WebStepResult[] = [];

  // Register every step's snapshot up front so a CLICK that follows a link to a
  // later step's URL is served the right page (the flow home → search →
  // results), not a blocked request.
  for (const step of task.steps) {
    await executor.execute({
      subaction: "network",
      networkAction: "route",
      url: step.url,
      responseBody: step.html,
    });
  }

  for (const step of task.steps) {
    let executed = false;
    let verified = false;
    let error: string | null = null;
    try {
      await executor.execute({ subaction: "navigate", url: step.url });
      await executor.execute(operationCommand(step));
      executed = true;

      const getCommand: BrowserWorkspaceCommand = step.check.selector
        ? {
            subaction: "get",
            getMode: step.check.getMode,
            selector: step.check.selector,
          }
        : { subaction: "get", getMode: step.check.getMode };
      const read = await executor.execute(getCommand);
      verified = asString(read.value) === step.check.equals;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    steps.push({
      actionUid: step.actionUid,
      operation: step.operation,
      executed,
      verified,
      error,
    });
  }

  const executedSteps = steps.filter((s) => s.executed).length;
  const verifiedSteps = steps.filter((s) => s.verified).length;
  return {
    taskId: task.id,
    website: task.website,
    engine: executor.engine,
    totalSteps: steps.length,
    executedSteps,
    verifiedSteps,
    stepAccuracy: steps.length === 0 ? 0 : verifiedSteps / steps.length,
    success: steps.length > 0 && verifiedSteps === steps.length,
    steps,
  };
}

export async function runMind2WebSuite(
  executor: BrowserCommandExecutor,
  tasks: readonly Mind2WebTask[],
  source: string,
): Promise<Mind2WebSuiteReport> {
  const results: Mind2WebTaskResult[] = [];
  for (const task of tasks) {
    results.push(await replayMind2WebTask(executor, task));
  }
  const totalSteps = results.reduce((n, r) => n + r.totalSteps, 0);
  const verifiedSteps = results.reduce((n, r) => n + r.verifiedSteps, 0);
  return {
    benchmark: "mind2web",
    engine: executor.engine,
    source,
    tasks: results,
    summary: {
      tasks: results.length,
      solved: results.filter((r) => r.success).length,
      totalSteps,
      verifiedSteps,
      stepAccuracy: totalSteps === 0 ? 0 : verifiedSteps / totalSteps,
    },
  };
}

const M2W_ORIGIN = "https://m2w.test";

/**
 * A self-contained Mind2Web-format task (mirrors the `sample_001` shape in
 * `packages/benchmarks/mind2web/dataset.py`) — a CLICK → TYPE → SELECT search
 * flow, each step its own cached snapshot with a real target selector and a
 * verifiable effect. Proves the replay seam end-to-end without the HF corpus.
 */
export const MIND2WEB_FIXTURE: Mind2WebTask = {
  id: "fixture_search_001",
  instruction:
    "Open search, enter 'wireless headphones', and sort results by rating.",
  website: "m2w.test",
  steps: [
    {
      actionUid: "a001",
      operation: "CLICK",
      url: `${M2W_ORIGIN}/home`,
      html: `<!doctype html><title>Home</title><body><a id="open-search" href="/search">Search</a></body>`,
      targetSelector: "#open-search",
      // CLICK navigates; verify we reached the search page.
      check: { getMode: "url", equals: `${M2W_ORIGIN}/search` },
    },
    {
      actionUid: "a002",
      operation: "TYPE",
      url: `${M2W_ORIGIN}/search`,
      html: `<!doctype html><title>Search</title><body><input id="q" name="q" type="text" value="" /></body>`,
      targetSelector: "#q",
      value: "wireless headphones",
      check: { getMode: "value", selector: "#q", equals: "wireless headphones" },
    },
    {
      actionUid: "a003",
      operation: "SELECT",
      url: `${M2W_ORIGIN}/results`,
      html: `<!doctype html><title>Results</title><body><select id="sort"><option value="relevance">Relevance</option><option value="rating">Rating</option><option value="price">Price</option></select></body>`,
      targetSelector: "#sort",
      value: "rating",
      check: { getMode: "value", selector: "#sort", equals: "rating" },
    },
  ],
};

/**
 * Load Mind2Web tasks. With `MIND2WEB_DATA_DIR` (a directory of converted task
 * JSON files — `{ id, instruction, website, steps }`), the real corpus drives
 * the lane; otherwise the embedded fixture does, so the un-gated path stays a
 * self-contained, reproducible check. Returns the `source` label too.
 */
export function loadMind2WebTasks(
  dir = process.env.MIND2WEB_DATA_DIR?.trim(),
): { tasks: Mind2WebTask[]; source: string } {
  if (dir && existsSync(dir)) {
    const tasks: Mind2WebTask[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(
        readFileSync(path.join(dir, file), "utf8"),
      ) as Mind2WebTask | Mind2WebTask[];
      for (const task of Array.isArray(parsed) ? parsed : [parsed]) {
        if (task?.id && Array.isArray(task.steps)) tasks.push(task);
      }
    }
    if (tasks.length > 0) {
      return { tasks, source: `MIND2WEB_DATA_DIR:${dir}` };
    }
  }
  return { tasks: [MIND2WEB_FIXTURE], source: "fixture" };
}
