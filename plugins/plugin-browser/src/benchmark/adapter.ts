/**
 * Browser benchmark adapter (#9476).
 *
 * The plugin-browser analog of `plugin-computeruse/src/osworld/adapter.ts`:
 * bridges a web-interaction benchmark to the real BROWSER command surface.
 *
 *   1. loadTask()       — register the task's routed pages, navigate to start
 *   2. getObservation() — read url/title/body through real `snapshot`/`get`
 *   3. executeAction()  — map a benchmark action to a BROWSER command + dispatch
 *   4. step()           — execute + observe (gymnasium-style), record trajectory
 *   5. rewardContext()  — a read seam the task scores against (real `get`s)
 *
 * Engine-agnostic: it dispatches through any {@link BrowserCommandExecutor}, so
 * the same suite runs against JSDOM web mode (deterministic, CI-safe) or a real
 * Chromium target, exactly like the OSWorld adapter accepts any
 * `ComputerUseService`.
 */

import {
  __resetBrowserWorkspaceStateForTests,
  closeBrowserWorkspaceTab,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../workspace/browser-workspace.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
  BrowserWorkspaceGetMode,
} from "../workspace/browser-workspace-types.js";
import type {
  BenchmarkAction,
  BenchmarkObservation,
  BenchmarkRewardContext,
  BenchmarkStepResult,
  BenchmarkTask,
  BrowserCommandExecutor,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export interface BrowserBenchmarkAdapterConfig {
  /** Step budget cap independent of a task's own `maxSteps`. */
  maxTrajectoryLength: number;
}

export class BrowserBenchmarkAdapter {
  private readonly executor: BrowserCommandExecutor;
  private readonly config: BrowserBenchmarkAdapterConfig;
  private stepCount = 0;
  private terminated = false;
  private trajectory: BenchmarkStepResult[] = [];
  private timestampSource: () => number;

  constructor(
    executor: BrowserCommandExecutor,
    config?: Partial<BrowserBenchmarkAdapterConfig> & {
      timestampSource?: () => number;
    },
  ) {
    this.executor = executor;
    this.config = {
      maxTrajectoryLength: config?.maxTrajectoryLength ?? 20,
    };
    this.timestampSource = config?.timestampSource ?? (() => Date.now());
  }

  get engine(): string {
    return this.executor.engine;
  }

  // ── Task setup ──────────────────────────────────────────────────────
  /**
   * Reset the episode, register the task's routed pages, and navigate to the
   * start URL — the benchmark "env reset". Returns the first observation.
   */
  async loadTask(
    task: BenchmarkTask,
    seed: number,
  ): Promise<BenchmarkObservation> {
    this.reset();
    const { startUrl, routes } = task.build(seed);
    for (const route of routes) {
      await this.executor.execute({
        subaction: "network",
        networkAction: "route",
        url: route.url,
        responseBody: route.html,
      });
    }
    await this.executor.execute({ subaction: "navigate", url: startUrl });
    return this.getObservation();
  }

  // ── Observation ─────────────────────────────────────────────────────
  async getObservation(): Promise<BenchmarkObservation> {
    let url = "";
    let title = "";
    let bodyText = "";
    try {
      const snap = await this.executor.execute({ subaction: "snapshot" });
      const value = asRecord(snap.value);
      url = asString(value.url);
      title = asString(value.title);
      bodyText = asString(value.bodyText);
    } catch {
      // Observation best-effort: a failed snapshot yields an empty frame, the
      // same contract OSWorldAdapter uses for a failed screenshot.
    }
    return {
      url,
      title,
      bodyText,
      step: this.stepCount,
      done: this.terminated,
    };
  }

  // ── Action execution ────────────────────────────────────────────────
  /**
   * Map a benchmark action to a BROWSER command and dispatch it through the
   * real router. Control actions (`done`) terminate without a command.
   */
  async executeAction(action: BenchmarkAction): Promise<{
    done: boolean;
    error?: { code: string; message: string };
    commandResult: BrowserWorkspaceCommandResult | null;
  }> {
    if (action.type === "done") {
      this.terminated = true;
      return { done: true, commandResult: null };
    }

    const command = this.toCommand(action);
    if (!command) {
      return {
        done: false,
        commandResult: null,
        error: {
          code: "unmapped_action",
          message: `Unmapped action: ${action.type}`,
        },
      };
    }

    try {
      const commandResult = await this.executor.execute(command);
      return { done: false, commandResult };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error &&
        typeof error === "object" &&
        "browserWorkspaceErrorCode" in error
          ? asString(
              (error as { browserWorkspaceErrorCode?: unknown })
                .browserWorkspaceErrorCode,
            )
          : "command_failed";
      return { done: false, commandResult: null, error: { code, message } };
    }
  }

  private toCommand(action: BenchmarkAction): BrowserWorkspaceCommand | null {
    switch (action.type) {
      case "click":
        return { subaction: "click", selector: action.selector };
      case "type":
        return {
          subaction: "type",
          selector: action.selector,
          value: action.value,
        };
      case "fill":
        return {
          subaction: "fill",
          selector: action.selector,
          value: action.value,
        };
      case "check":
        return { subaction: "check", selector: action.selector };
      case "uncheck":
        return { subaction: "uncheck", selector: action.selector };
      case "select":
        return {
          subaction: "select",
          selector: action.selector,
          value: action.value,
        };
      case "press":
        return {
          subaction: "press",
          selector: action.selector,
          key: action.key,
        };
      case "navigate":
        return { subaction: "navigate", url: action.url };
      default:
        return null;
    }
  }

  // ── Gymnasium-style step ────────────────────────────────────────────
  async step(action: BenchmarkAction): Promise<BenchmarkStepResult> {
    this.stepCount++;
    const result = await this.executeAction(action);
    const trajectoryExceeded =
      this.stepCount >= this.config.maxTrajectoryLength;
    const observation = await this.getObservation();
    const stepResult: BenchmarkStepResult = {
      action,
      observation,
      commandResult: result.commandResult,
      error: result.error,
      done: result.done || trajectoryExceeded,
      timestamp: this.timestampSource(),
    };
    this.trajectory.push(stepResult);
    return stepResult;
  }

  // ── Reward seam ─────────────────────────────────────────────────────
  rewardContext(): BenchmarkRewardContext {
    const get = async (
      getMode: BrowserWorkspaceGetMode,
      selector?: string,
    ): Promise<unknown> => {
      const command: BrowserWorkspaceCommand = selector
        ? { subaction: "get", getMode, selector }
        : { subaction: "get", getMode };
      const result = await this.executor.execute(command);
      return result.value;
    };
    return {
      getValue: async (selector) => asString(await get("value", selector)),
      getChecked: async (selector) => Boolean(await get("checked", selector)),
      getText: async (selector) => asString(await get("text", selector)),
      getCount: async (selector) => Number(await get("count", selector)) || 0,
      getTitle: async () => asString(await get("title")),
      getUrl: async () => asString(await get("url")),
    };
  }

  // ── State ───────────────────────────────────────────────────────────
  reset(): void {
    this.stepCount = 0;
    this.terminated = false;
    this.trajectory = [];
  }

  getTrajectory(): BenchmarkStepResult[] {
    return [...this.trajectory];
  }

  getStepCount(): number {
    return this.stepCount;
  }

  isTerminated(): boolean {
    return this.terminated;
  }
}

/**
 * Build a {@link BrowserCommandExecutor} backed by the real
 * `executeBrowserWorkspaceCommand` router in JSDOM web mode — the same mock-free
 * path the `browser-workspace-web-real-code` lane drives. Each executor owns one
 * fresh tab; `dispose()` closes it.
 */
export async function createWorkspaceBenchmarkExecutor(
  env: NodeJS.ProcessEnv = {},
): Promise<{
  executor: BrowserCommandExecutor;
  tabId: string;
  dispose: () => Promise<void>;
}> {
  await __resetBrowserWorkspaceStateForTests();
  const tab = await openBrowserWorkspaceTab(
    { show: true, url: "about:blank" },
    env,
  );
  const executor: BrowserCommandExecutor = {
    engine: "jsdom-web",
    execute: (command) =>
      executeBrowserWorkspaceCommand(
        command.id ? command : { ...command, id: tab.id },
        env,
      ),
  };
  return {
    executor,
    tabId: tab.id,
    dispose: async () => {
      await closeBrowserWorkspaceTab(tab.id, env);
    },
  };
}
