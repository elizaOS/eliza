import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { listProcesses } from "../platform/process-list.js";
import { listWindows } from "../platform/windows-list.js";
import type { Scene } from "../scene/scene-types.js";
import type { ActionHistoryEntry } from "../types.js";

export const VISION_CONTEXT_SERVICE_TYPE = "vision-context";
export const VISION_CONTEXT_TASK_GOAL_CACHE_KEY = "vision-context:task-goal";

export type VisionContextBBox = [number, number, number, number];

export interface VisionContextFocusedWindow {
  app: string;
  title: string;
  bbox: VisionContextBBox | null;
}

export interface VisionContextRecentAction {
  action: string;
  ts: number;
}

export interface VisionContext {
  openApps: string[];
  focusedWindow: VisionContextFocusedWindow | null;
  recentActions: VisionContextRecentAction[];
  currentTaskGoal: string | null;
}

interface ComputerUseContextSource {
  getCurrentScene(): Scene | null;
  refreshScene?(mode?: "idle" | "active" | "agent-turn"): Promise<Scene>;
  getRecentActions?(): ActionHistoryEntry[];
}

interface RuntimeCacheReader {
  getCache?<T>(key: string): Promise<T | undefined>;
}

function isComputerUseContextSource(
  candidate: unknown,
): candidate is ComputerUseContextSource {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { getCurrentScene?: unknown }).getCurrentScene ===
      "function"
  );
}

function uniqueProcessNames(): string[] {
	const names = new Set<string>();
	for (const process of listProcesses()) {
		const name = process.name.trim();
		if (name) names.add(name);
		if (names.size >= 50) break;
	}
	const out = [...names];
	if (out[0] === "launchd") return [];
	return out;
}

function uniqueVisibleAppNames(scene: Scene | null): string[] {
  if (!scene) return [];
  const names = new Set<string>();
  for (const app of scene.apps) {
    if (app.windows.length === 0) continue;
    const name = app.name.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function focusedWindowFromScene(
  scene: Scene | null,
): VisionContextFocusedWindow | null {
  if (!scene?.focused_window) return null;
  const focused = scene.focused_window;
  return {
    app: focused.app,
    title: focused.title,
    bbox: focused.bounds,
  };
}

function focusedWindowFromPlatform(): VisionContextFocusedWindow | null {
  const [window] = listWindows();
  if (!window) return null;
	const app = window.app.trim();
	const title = window.title.trim();
	if (!app && !title) return null;
	if (!app && title === "unknown") return null;
	return {
		app,
		title,
    bbox: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class VisionContextProvider extends Service {
  static override serviceType = VISION_CONTEXT_SERVICE_TYPE;

  private readonly recentActions: VisionContextRecentAction[] = [];

  override capabilityDescription =
    "Provides compact desktop scene context for vision prompts.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<VisionContextProvider> {
    return new VisionContextProvider(runtime);
  }

  override async stop(): Promise<void> {
    this.recentActions.length = 0;
  }

  async getContext(): Promise<VisionContext> {
    const computerUse = this.runtime.getService("computeruse");
		const source = isComputerUseContextSource(computerUse) ? computerUse : null;
		const scene = await this.getScene(source);
		const processNames = uniqueProcessNames();
		const sceneAppNames = uniqueVisibleAppNames(scene);
		return {
			openApps: sceneAppNames.length > 0 ? sceneAppNames : processNames,
      focusedWindow: focusedWindowFromScene(scene) ?? focusedWindowFromPlatform(),
      recentActions: this.getRecentActions(source),
      currentTaskGoal: await this.getCurrentTaskGoal(),
    };
  }

  noteAction(action: string): void {
    const label = action.trim();
    if (!label) {
      throw new Error("VisionContextProvider requires a non-empty action label");
    }
    this.recentActions.push({ action: label, ts: Date.now() });
    if (this.recentActions.length > 10) {
      this.recentActions.splice(0, this.recentActions.length - 10);
    }
  }

  private async getScene(
    source: ComputerUseContextSource | null,
  ): Promise<Scene | null> {
    if (!source) return null;
    const current = source.getCurrentScene();
    if (current || !source.refreshScene) return current;
    try {
      return await source.refreshScene("agent-turn");
    } catch (error) {
      logger.warn("[vision-context] refreshScene failed:", errorMessage(error));
      return null;
    }
  }

  private getRecentActions(
    source: ComputerUseContextSource | null,
  ): VisionContextRecentAction[] {
    if (!source?.getRecentActions) return [...this.recentActions];
    const sourceActions = source.getRecentActions().map((entry) => ({
      action: entry.action,
      ts: entry.timestamp,
    }));
    return sourceActions.length > 0 ? sourceActions : [...this.recentActions];
  }

  private async getCurrentTaskGoal(): Promise<string | null> {
    const runtime = this.runtime as IAgentRuntime & RuntimeCacheReader;
    try {
      const cached = await runtime.getCache?.<unknown>(
        VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
      );
      if (typeof cached === "string" && cached.trim()) return cached.trim();
    } catch (error) {
      logger.debug(
        "[vision-context] task goal cache read failed:",
        errorMessage(error),
      );
    }
    try {
      const setting = this.runtime.getSetting("VISION_CONTEXT_TASK_GOAL");
      if (typeof setting === "string" && setting.trim()) return setting.trim();
    } catch {
      // Optional setting.
    }
    return null;
  }
}
