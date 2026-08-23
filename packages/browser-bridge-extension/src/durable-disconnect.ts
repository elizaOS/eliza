/**
 * Coordinates extension cancellation and authenticated server revocation.
 * Local credentials are erased only after every cancellation observer settles
 * and durable revocation succeeds.
 */
export type DurableDisconnectDependencies = {
  cancelSync: () => Promise<void>;
  cancelEnrollment: () => Promise<void>;
  revoke: (() => Promise<void>) | null;
  clearConfig: () => Promise<void>;
  suppressEnrollment: () => Promise<void>;
};

export function disconnectFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Disconnect failed: ${detail}`;
}

export async function performDurableDisconnect(
  dependencies: DurableDisconnectDependencies,
): Promise<void> {
  const results = await Promise.allSettled([
    dependencies.cancelSync(),
    dependencies.cancelEnrollment(),
    dependencies.revoke?.() ?? Promise.resolve(),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;

  await dependencies.suppressEnrollment();
  await dependencies.clearConfig();
}
