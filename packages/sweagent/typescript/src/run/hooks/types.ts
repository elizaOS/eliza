/**
 * Type definitions for run hooks
 */

import { ProblemStatement, ProblemStatementConfig } from '../../agent/problem-statement';
import { SWEEnv } from '../../environment/swe-env';
import { AgentRunResult } from '../../types';

/**
 * Hook structure for the web server or other addons to interface with
 */
export interface RunHook {
  /**
   * Called when hook is initialized
   */
  onInit(run: Record<string, unknown>): void;

  /**
   * Called at the beginning of Main.main
   */
  onStart(): void;

  /**
   * Called at the end of Main.main
   */
  onEnd(): void;

  /**
   * Called at the beginning of each instance loop in Main.run
   */
  onInstanceStart(params: {
    index: number;
    env: SWEEnv;
    problemStatement: ProblemStatement | ProblemStatementConfig;
  }): void;

  /**
   * Called when an instance is skipped in Main.run
   */
  onInstanceSkipped(): void;

  /**
   * Called when an instance is completed in Main.run
   */
  onInstanceCompleted(params: { result: AgentRunResult }): void;
}

/**
 * Abstract base class for run hooks
 */
export abstract class AbstractRunHook implements RunHook {
  onInit(_run: Record<string, unknown>): void {
    // Default implementation - can be overridden
  }

  onStart(): void {
    // Default implementation - can be overridden
  }

  onEnd(): void {
    // Default implementation - can be overridden
  }

  onInstanceStart(_params: {
    index: number;
    env: SWEEnv;
    problemStatement: ProblemStatement | ProblemStatementConfig;
  }): void {
    // Default implementation - can be overridden
  }

  onInstanceSkipped(): void {
    // Default implementation - can be overridden
  }

  onInstanceCompleted(_params: { result: AgentRunResult }): void {
    // Default implementation - can be overridden
  }
}

/**
 * Combined run hooks manager
 */
export class CombinedRunHooks implements RunHook {
  private _hooks: RunHook[] = [];

  addHook(hook: RunHook): void {
    this._hooks.push(hook);
  }

  get hooks(): RunHook[] {
    return this._hooks;
  }

  onInit(run: Record<string, unknown>): void {
    for (const hook of this._hooks) {
      hook.onInit(run);
    }
  }

  onStart(): void {
    for (const hook of this._hooks) {
      hook.onStart();
    }
  }

  onEnd(): void {
    for (const hook of this._hooks) {
      hook.onEnd();
    }
  }

  onInstanceStart(params: {
    index: number;
    env: SWEEnv;
    problemStatement: ProblemStatement | ProblemStatementConfig;
  }): void {
    for (const hook of this._hooks) {
      hook.onInstanceStart(params);
    }
  }

  onInstanceSkipped(): void {
    for (const hook of this._hooks) {
      hook.onInstanceSkipped();
    }
  }

  onInstanceCompleted(params: { result: AgentRunResult }): void {
    for (const hook of this._hooks) {
      hook.onInstanceCompleted(params);
    }
  }
}
