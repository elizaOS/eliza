/**
 * Status hook for updating agent status
 * Converted from sweagent/agent/hooks/status.py
 */

import { AbstractAgentHook } from './abstract';
import { AgentInfo, StepOutput } from '../../types';

/**
 * Hook for setting status during agent execution
 */
export class SetStatusAgentHook extends AbstractAgentHook {
  private callable: (id: string, message: string) => void;
  private id: string;
  private iStep: number = 0;
  private cost: number = 0.0;
  private iAttempt: number = 0;
  private previousCost: number = 0.0;

  constructor(id: string, callable: (id: string, message: string) => void) {
    super();
    this.id = id;
    this.callable = callable;
  }

  onSetupAttempt(): void {
    this.iAttempt++;
    this.iStep = 0;
    // Costs will be reset for the next attempt
    this.previousCost += this.cost;
    this.cost = 0.0;
  }

  private update(message: string): void {
    this.callable(this.id, message);
  }

  onStepStart(): void {
    this.iStep++;
    const attemptStr = this.iAttempt > 1 ? `Attempt ${this.iAttempt} ` : '';
    this.update(
      `${attemptStr}Step ${this.iStep.toString().padStart(3)} ($${(this.previousCost + this.cost).toFixed(2)})`,
    );
  }

  onStepDone(_step: StepOutput, info: AgentInfo): void {
    // Update cost from model stats
    if (info.modelStats && typeof info.modelStats.instanceCost === 'number') {
      this.cost = info.modelStats.instanceCost;
    }
  }

  onToolsInstallationStarted(): void {
    this.update('Installing tools');
  }
}
