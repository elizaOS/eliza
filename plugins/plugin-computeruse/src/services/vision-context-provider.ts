import { type IAgentRuntime, Service } from "@elizaos/core";
import type { ComputerUseService } from "./computer-use-service.js";

export const VISION_CONTEXT_SERVICE_TYPE = "vision-context";
export const VISION_CONTEXT_TASK_GOAL_CACHE_KEY =
  "computeruse:current-task-goal";

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

export class VisionContextProvider extends Service {
  static serviceType = VISION_CONTEXT_SERVICE_TYPE;

  capabilityDescription =
    "Provides compact desktop scene context for vision prompts";

  static async start(runtime: IAgentRuntime): Promise<VisionContextProvider> {
    return new VisionContextProvider(runtime);
  }

  async stop(): Promise<void> {}

  async getContext(): Promise<VisionContext> {
    const computerUse = this.runtime.getService("computeruse") as
      | ComputerUseService
      | undefined;
    const scene = computerUse?.getCurrentScene() ?? null;

    return {
      openApps: scene ? uniqueNonEmpty(scene.apps.map((app) => app.name)) : [],
      focusedWindow: scene?.focused_window
        ? {
            app: scene.focused_window.app,
            title: scene.focused_window.title,
            bbox: scene.focused_window.bounds,
          }
        : null,
      recentActions:
        computerUse?.getRecentActions().map((entry) => ({
          action: entry.action,
          ts: entry.timestamp,
        })) ?? [],
      currentTaskGoal: await this.getCurrentTaskGoal(),
    };
  }

  private async getCurrentTaskGoal(): Promise<string | null> {
    try {
      const value = await this.runtime.getCache<unknown>(
        VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
      );
      return typeof value === "string" && value.trim() ? value : null;
    } catch {
      return null;
    }
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
