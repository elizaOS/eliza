/**
 * Serializes sync requests while coalescing work that arrives during an active
 * run. Every concurrent caller observes the state produced after the queued
 * work drains, and request-specific escalation flags are merged by the caller.
 */
export class CoalescingSyncRunner<TRequest, TResult> {
  private pendingRequest: TRequest | null = null;
  private runnerPromise: Promise<TResult> | null = null;

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

    const runner = Promise.resolve()
      .then(async () => await this.drain())
      .finally(() => {
        if (this.runnerPromise === runner) {
          this.runnerPromise = null;
        }
      });
    this.runnerPromise = runner;
    return runner;
  }

  private async drain(): Promise<TResult> {
    const firstRequest = this.takePendingRequest();
    let result = await this.execute(firstRequest);

    while (this.pendingRequest !== null) {
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
