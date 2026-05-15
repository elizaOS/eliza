import { type IAgentRuntime, logger, Service } from "@elizaos/core";
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
  getRecentActions(): ActionHistoryEntry[];
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
      "function" &&
    typeof (candidate as { getRecentActions?: unknown }).getRecentActions ===
      "function"
  );
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

export class VisionContextProvider extends Service {
  static override serviceType = VISION_CONTEXT_SERVICE_TYPE;

  override capabilityDescription =
    "Provides compact desktop scene context for vision prompts.";

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<VisionContextProvider> {
    return new VisionContextProvider(runtime);
  }

  override async stop(): Promise<void> {
    // Stateless provider.
  }

  async getContext(): Promise<VisionContext> {
    const computerUse = this.runtime.getService("computeruse");
    const source = isComputerUseContextSource(computerUse) ? computerUse : null;
    const scene = await this.getScene(source);
    return {
      openApps: uniqueVisibleAppNames(scene),
      focusedWindow: focusedWindowFromScene(scene),
      recentActions: this.getRecentActions(source),
      currentTaskGoal: await this.getCurrentTaskGoal(),
    };
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
      logger.warn("[vision-context] refreshScene failed:", error);
      return null;
    }
  }

  private getRecentActions(
    source: ComputerUseContextSource | null,
  ): VisionContextRecentAction[] {
    if (!source) return [];
    return source.getRecentActions().map((entry) => ({
      action: entry.action,
      ts: entry.timestamp,
    }));
  }

  private async getCurrentTaskGoal(): Promise<string | null> {
    const runtime = this.runtime as IAgentRuntime & RuntimeCacheReader;
    try {
      const cached = await runtime.getCache?.<unknown>(
        VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
      );
      if (typeof cached === "string" && cached.trim()) return cached.trim();
    } catch (error) {
      logger.debug("[vision-context] task goal cache read failed:", error);
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
