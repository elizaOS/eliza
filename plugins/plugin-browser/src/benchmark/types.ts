/**
 * Browser benchmark harness types (#9476).
 *
 * The plugin-computeruse side has a real benchmark wired through the live
 * computer-use action surface (`src/osworld/adapter.ts` + the OSWorld
 * `*.real.test.ts` lanes). plugin-browser had a CI-asserted parity matrix, a
 * JSDOM real-code lane, and a typed error contract — but **no benchmark wired
 * through the real BROWSER command path**. The web benchmarks (Mind2Web,
 * WebShop, VisualWebBench) all bypass plugin-browser via the inference layer.
 *
 * This module closes that gap: a MiniWoB++-style web-interaction benchmark
 * whose every action is dispatched through the real
 * `executeBrowserWorkspaceCommand` router (the same mock-free path the
 * `browser-workspace-web-real-code` lane drives) and whose reward is computed
 * from observable DOM state read back through real BROWSER `get`/`state`
 * commands. No mock service stands in for the thing under test.
 *
 * Engine-agnostic by design (mirrors how `OSWorldAdapter` takes a
 * `ComputerUseService`): the adapter drives any {@link BrowserCommandExecutor},
 * so the same task suite can run against the JSDOM web mode (deterministic,
 * CI-safe, zero-dependency) or — once the deferred CI infra lands — a real
 * Chromium-backed target.
 */

import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "../workspace/browser-workspace-types.js";

/**
 * The seam the adapter dispatches through. A JSDOM-web executor binds
 * {@link executeBrowserWorkspaceCommand} to a tab; a future Chromium executor
 * would wrap a real `BrowserService` target. The adapter never imports a
 * concrete backend, exactly like the OSWorld adapter never imports a concrete
 * OS driver.
 */
export interface BrowserCommandExecutor {
  /** Short id of the backing engine, e.g. `"jsdom-web"` or `"chromium"`. */
  readonly engine: string;
  /** Execute a single BROWSER workspace command through the real router. */
  execute(
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult>;
}

/** A benchmark-level action a policy chooses; mapped to a BROWSER command. */
export type BenchmarkActionType =
  | "click"
  | "type"
  | "fill"
  | "check"
  | "uncheck"
  | "select"
  | "press"
  | "navigate"
  | "done";

export interface BenchmarkAction {
  type: BenchmarkActionType;
  /** CSS selector for element-targeted actions. */
  selector?: string;
  /** Text to enter for `type`/`fill`. */
  value?: string;
  /** Key name for `press`. */
  key?: string;
  /** Destination for `navigate`. */
  url?: string;
  /** Human-readable rationale (oracle label / policy reasoning). */
  note?: string;
}

/** What a policy observes each step — read from the live DOM, never faked. */
export interface BenchmarkObservation {
  url: string;
  title: string;
  /** Visible body text of the active tab (includes the task `#wob-query`). */
  bodyText: string;
  /** 0-based index of the step that produced this observation. */
  step: number;
  /** True once the episode has terminated (policy emitted `done`). */
  done: boolean;
}

/** One executed step: the action, the real command result, and any error. */
export interface BenchmarkStepResult {
  action: BenchmarkAction;
  observation: BenchmarkObservation;
  commandResult: BrowserWorkspaceCommandResult | null;
  error?: { code: string; message: string };
  done: boolean;
  timestamp: number;
}

/**
 * Reward seam handed to a task's `reward()` — every read goes through a real
 * BROWSER `get`/`state` command against the live tab. A task computes its
 * success criterion from these observations; it cannot inspect adapter
 * internals or fabricate state.
 */
export interface BenchmarkRewardContext {
  getValue(selector: string): Promise<string>;
  getChecked(selector: string): Promise<boolean>;
  getText(selector: string): Promise<string>;
  getCount(selector: string): Promise<number>;
  getTitle(): Promise<string>;
  getUrl(): Promise<string>;
}

/**
 * A self-contained MiniWoB++-style task. The HTML is pure markup served via the
 * BROWSER `network route` interceptor (no external network, no page scripts —
 * web mode hard-blocks script execution, GHSA-mhhr-9ph9-64j7), so the reward is
 * computed entirely from observable DOM state.
 */
export interface BenchmarkTask {
  /** MiniWoB task id, e.g. `"click-button"`. */
  id: string;
  /** Benchmark family, e.g. `"miniwob++"`. */
  family: string;
  /** One-line description of the task family. */
  description: string;
  /** The natural-language goal for `seed` (also rendered into the page). */
  utterance(seed: number): string;
  /** Deterministic environment for `seed`: routes to register + the start URL. */
  build(seed: number): {
    startUrl: string;
    routes: ReadonlyArray<{ url: string; html: string }>;
  };
  /** The known-correct action sequence for `seed` (oracle policy / success path). */
  oracle(seed: number): BenchmarkAction[];
  /** Reward in `[0, 1]` from observable DOM state. 1 = solved. */
  reward(ctx: BenchmarkRewardContext, seed: number): Promise<number>;
  /** Step budget before the episode is force-terminated. */
  maxSteps: number;
}

/** Result of a single task×seed episode. */
export interface BenchmarkEpisodeResult {
  taskId: string;
  family: string;
  seed: number;
  utterance: string;
  engine: string;
  policy: string;
  reward: number;
  success: boolean;
  steps: number;
  /** Per-step record of the real commands the adapter dispatched. */
  trajectory: Array<{
    action: BenchmarkAction;
    resultMode: string | null;
    error: string | null;
  }>;
  error?: string;
}

/** Aggregate report for a whole suite run — the committed artifact shape. */
export interface BenchmarkSuiteReport {
  benchmark: string;
  engine: string;
  policy: string;
  seedsPerTask: number;
  episodes: BenchmarkEpisodeResult[];
  summary: {
    total: number;
    solved: number;
    successRate: number;
    byTask: Array<{ taskId: string; solved: number; total: number }>;
  };
}
