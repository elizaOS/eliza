/**
 * Fences asynchronous extension work across explicit disconnect boundaries so
 * an older enrollment, sync, or browser session cannot publish stale state.
 */
export class OperationCancelledError extends Error {
  constructor() {
    super("Browser bridge operation was cancelled.");
    this.name = "OperationCancelledError";
  }
}

export class OperationGeneration {
  private generation = 0;
  private blocked = false;

  capture(): number {
    return this.generation;
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  cancelAndBlock(): void {
    this.generation += 1;
    this.blocked = true;
  }

  resume(): void {
    this.blocked = false;
  }

  isCurrent(generation: number): boolean {
    return !this.blocked && generation === this.generation;
  }

  assertCurrent(generation: number): void {
    if (!this.isCurrent(generation)) throw new OperationCancelledError();
  }

  async runCurrent<T>(
    generation: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertCurrent(generation);
    const result = await operation();
    this.assertCurrent(generation);
    return result;
  }
}
