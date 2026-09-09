/** Captures one login intent before asynchronous provider work and revalidates its canonical authority at each short client transaction. Human prompts never hold the origin-wide session lock. */
import {
  getStewardTabSessionAuthorityCoordinator,
  runStewardSessionAuthorityExclusive,
  type StewardSessionAuthoritySnapshot,
  type StewardSessionAuthorityWorkContext,
} from "@elizaos/shared/steward-session-client";

export type SignInAttempt = {
  expected: StewardSessionAuthoritySnapshot;
  controller: AbortController;
  ready: boolean;
};

export function createSignInAttempt(): SignInAttempt {
  return {
    expected: getStewardTabSessionAuthorityCoordinator().readSnapshot(),
    controller: new AbortController(),
    ready: false,
  };
}

export function withSignInAttempt<T>(
  attempt: SignInAttempt,
  work: (authority: StewardSessionAuthorityWorkContext) => Promise<T>,
): Promise<T> {
  return runStewardSessionAuthorityExclusive({
    kind: "callback-restore",
    expectedToken: attempt.expected.token,
    expectedGeneration: attempt.expected.generation,
    expectedScope: attempt.expected.scope,
    signal: attempt.controller.signal,
    work,
  });
}
