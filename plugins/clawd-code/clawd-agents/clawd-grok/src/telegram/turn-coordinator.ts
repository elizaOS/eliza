/**
 * Serialize async turns (local TUI + Telegram) so only one Agent.processMessage runs at a time.
 */
export function createTurnCoordinator() {
  let chain: Promise<unknown> = Promise.resolve();

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = chain.then(() => fn());
      chain = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}

export type TurnCoordinator = ReturnType<typeof createTurnCoordinator>;
