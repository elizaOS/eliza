/** Isolates concurrent ACP prompt attribution and cancellation by session. */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ActiveAcpPrompt<TUpdate> {
  sessionId: string;
  publish: (update: TUpdate) => Promise<unknown>;
}

export class AcpActivePromptRegistry<TUpdate> {
  private readonly context = new AsyncLocalStorage<ActiveAcpPrompt<TUpdate>>();
  private readonly controllers = new Map<string, AbortController>();

  current(): ActiveAcpPrompt<TUpdate> | undefined {
    return this.context.getStore();
  }

  cancel(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run<TResult>(
    prompt: ActiveAcpPrompt<TUpdate>,
    operation: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<TResult> {
    const controller = new AbortController();
    this.controllers.set(prompt.sessionId, controller);
    try {
      return await this.context.run(prompt, () => operation(controller.signal));
    } finally {
      if (this.controllers.get(prompt.sessionId) === controller) {
        this.controllers.delete(prompt.sessionId);
      }
    }
  }
}
