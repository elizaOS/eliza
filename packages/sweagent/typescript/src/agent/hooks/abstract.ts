/**
 * Abstract hooks for agent lifecycle events
 * Converted from sweagent/agent/hooks/abstract.py
 */

import { AgentInfo, StepOutput, Trajectory } from '../../types';

// Forward declaration to avoid circular dependency
export interface DefaultAgent {
  name: string;
  // Add other properties as needed
}

/**
 * Abstract base class for agent hooks
 */
export abstract class AbstractAgentHook {
  /**
   * Called when the agent is initialized
   * Note: Depending on the internals of Agent should be done with care,
   * it's best to use this as little as possible.
   */
  onInit(_agent: DefaultAgent): void {
    // Default implementation - do nothing
  }

  /**
   * Called when a run starts
   */
  onRunStart(): void {
    // Default implementation - do nothing
  }

  /**
   * Called when a step starts
   */
  onStepStart(): void {
    // Default implementation - do nothing
  }

  /**
   * Called when actions have been generated
   */
  onActionsGenerated(_step: StepOutput): void {
    // Default implementation - do nothing
  }

  /**
   * Called when an action is about to be executed
   */
  onActionStarted(_step: StepOutput): void {
    // Default implementation - do nothing
  }

  /**
   * Called after an action has been executed
   */
  onActionExecuted(_step: StepOutput): void {
    // Default implementation - do nothing
  }

  /**
   * Called when a step is done
   */
  onStepDone(_step: StepOutput, _info: AgentInfo): void {
    // Default implementation - do nothing
  }

  /**
   * Called when a run is done
   */
  onRunDone(_trajectory: Trajectory, _info: AgentInfo): void {
    // Default implementation - do nothing
  }

  /**
   * Called when a setup attempt is made
   */
  onSetupAttempt(): void {
    // Default implementation - do nothing
  }

  /**
   * Called before querying the model
   */
  onModelQuery(_messages: Array<{ [key: string]: string }>, _agent: string): void {
    // Default implementation - do nothing
  }

  /**
   * Called when a message is added to the query
   */
  onQueryMessageAdded(_params: {
    agent: string;
    role: string;
    content: string;
    messageType: string;
    isDemo?: boolean;
    thought?: string;
    action?: string;
    toolCalls?: Array<{ [key: string]: string }> | null;
    toolCallIds?: string[] | null;
    thinkingBlocks?: Array<{ [key: string]: string }> | null;
  }): void {
    // Default implementation - do nothing
  }

  /**
   * Called when setup is done
   */
  onSetupDone(): void {
    // Default implementation - do nothing
  }

  /**
   * Called when tools installation starts
   */
  onToolsInstallationStarted(): void {
    // Default implementation - do nothing
  }
}

/**
 * Combined agent hook that manages multiple hooks
 */
export class CombinedAgentHook extends AbstractAgentHook {
  private hooks: AbstractAgentHook[] = [];

  constructor(hooks?: AbstractAgentHook[]) {
    super();
    this.hooks = hooks || [];
  }

  addHook(hook: AbstractAgentHook): void {
    this.hooks.push(hook);
  }

  get allHooks(): AbstractAgentHook[] {
    return this.hooks;
  }

  onInit(_agent: DefaultAgent): void {
    for (const hook of this.hooks) {
      hook.onInit(_agent);
    }
  }

  onRunStart(): void {
    for (const hook of this.hooks) {
      hook.onRunStart();
    }
  }

  onStepStart(): void {
    for (const hook of this.hooks) {
      hook.onStepStart();
    }
  }

  onActionsGenerated(_step: StepOutput): void {
    for (const hook of this.hooks) {
      hook.onActionsGenerated(_step);
    }
  }

  onActionStarted(_step: StepOutput): void {
    for (const hook of this.hooks) {
      hook.onActionStarted(_step);
    }
  }

  onActionExecuted(_step: StepOutput): void {
    for (const hook of this.hooks) {
      hook.onActionExecuted(_step);
    }
  }

  onStepDone(_step: StepOutput, _info: AgentInfo): void {
    for (const hook of this.hooks) {
      hook.onStepDone(_step, _info);
    }
  }

  onRunDone(_trajectory: Trajectory, _info: AgentInfo): void {
    for (const hook of this.hooks) {
      hook.onRunDone(_trajectory, _info);
    }
  }

  onSetupAttempt(): void {
    for (const hook of this.hooks) {
      hook.onSetupAttempt();
    }
  }

  onModelQuery(_messages: Array<{ [key: string]: string }>, _agent: string): void {
    for (const hook of this.hooks) {
      hook.onModelQuery(_messages, _agent);
    }
  }

  onQueryMessageAdded(_params: {
    agent: string;
    role: string;
    content: string;
    messageType: string;
    isDemo?: boolean;
    thought?: string;
    action?: string;
    toolCalls?: Array<{ [key: string]: string }> | null;
    toolCallIds?: string[] | null;
    thinkingBlocks?: Array<{ [key: string]: string }> | null;
  }): void {
    for (const hook of this.hooks) {
      hook.onQueryMessageAdded(_params);
    }
  }

  onSetupDone(): void {
    for (const hook of this.hooks) {
      hook.onSetupDone();
    }
  }

  onToolsInstallationStarted(): void {
    for (const hook of this.hooks) {
      hook.onToolsInstallationStarted();
    }
  }
}
