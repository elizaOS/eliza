/**
 * Main-window first-run boot patches: the two dev query-param entry points for
 * re-exercising onboarding, wired in one place so the order is testable.
 *
 * - `?reset` — the fresh-session escape hatch. Clears persisted client state
 *   (active server, setup step, first-run-complete) and sets the durable
 *   force-fresh flag so the next boot lands on onboarding.
 * - `?onboarding-replay=1` — the non-destructive replay (#14382). Dev builds
 *   only; overlays the client so it *reports* fresh while the real agent,
 *   its config, and all server state stay untouched. This is the safe path
 *   for QA on a real, memory-laden agent.
 *
 * Ordering is load-bearing: `installForceFreshFirstRunClientPatch` is
 * first-install-wins (it refuses to double-patch a client), so the replay must
 * arm BEFORE the durable patch installs. If the durable patch owned the slot,
 * the replay's ephemeral force-fresh flag would never be read and
 * `?onboarding-replay=1` would silently do nothing. The regression test in
 * `test/first-run-boot-patches.test.ts` locks this order behaviorally.
 */
import {
  applyForceFreshFirstRunReset,
  installForceFreshFirstRunClientPatch,
} from "@elizaos/ui/platform/first-run-reset";
import {
  armOnboardingReplay,
  type OnboardingReplayHandle,
} from "@elizaos/ui/platform/onboarding-replay";
import type { FirstRunClientLike } from "@elizaos/ui/platform/types";
import {
  shouldInstallMainWindowFirstRunPatches,
  type WindowShellRoute,
} from "@elizaos/ui/platform/window-shell";

const INERT_HANDLE: OnboardingReplayHandle = {
  active: false,
  uninstall: () => {},
};

/**
 * Installs the main-window first-run boot patches (`?reset` +
 * `?onboarding-replay=1`). No-op for detached/overlay window shells. Returns
 * the replay handle so a caller can inspect whether a replay is active;
 * dropping the query param and reloading is the normal way a replay ends, so
 * the handle's `uninstall` is not needed on the boot path.
 */
export function installMainWindowFirstRunBootPatches(
  client: FirstRunClientLike,
  windowShellRoute: WindowShellRoute,
): OnboardingReplayHandle {
  if (!shouldInstallMainWindowFirstRunPatches(windowShellRoute)) {
    return INERT_HANDLE;
  }
  const replay = armOnboardingReplay(client);
  applyForceFreshFirstRunReset();
  installForceFreshFirstRunClientPatch(client);
  return replay;
}
