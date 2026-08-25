/**
 * Serializes sync requests while coalescing work that arrives during an active
 * run. Every concurrent caller observes the state produced after the queued
 * work drains, and request-specific escalation flags are merged by the caller.
 */
export class CoalescingSyncRunner<TRequest, TResult> {
  private pendingRequest: TRequest | null = null;
  private runnerPromise: Promise<TResult> | null = null;
  private generation = 0;

  constructor(
    private readonly mergeRequests: (
      current: TRequest | null,
      next: TRequest,
    ) => TRequest,
    private readonly execute: (request: TRequest) => Promise<TResult>,
  ) {}

  request(next: TRequest): Promise<TResult> {
    this.pendingRequest = this.mergeRequests(this.pendingRequest, next);
    if (this.runnerPromise) {
      return this.runnerPromise;
    }

    const generation = this.generation;
    const runner = Promise.resolve()
      .then(async () => await this.drain(generation))
      .finally(() => {
        if (this.runnerPromise === runner) {
          this.runnerPromise = null;
        }
      });
    this.runnerPromise = runner;
    return runner;
  }

  /**
   * Drops queued work and waits until the active generation can no longer
   * publish a result through the runner.
   */
  async cancelPending(): Promise<void> {
    this.generation += 1;
    this.pendingRequest = null;
    const active = this.runnerPromise;
    this.runnerPromise = null;
    if (active) {
      try {
        await active;
      } catch {
        // error-policy:J5 The caller that requested this same runner promise
        // remains the primary observer of its rejection.
      }
    }
  }

  private async drain(generation: number): Promise<TResult> {
    const firstRequest = this.takePendingRequest();
    let result = await this.execute(firstRequest);

    while (generation === this.generation && this.pendingRequest !== null) {
      result = await this.execute(this.takePendingRequest());
    }

    return result;
  }

  private takePendingRequest(): TRequest {
    const request = this.pendingRequest;
    if (request === null) {
      throw new Error(
        "A coalesced sync run started without a pending request.",
      );
    }
    this.pendingRequest = null;
    return request;
  }
}
