/**
 * Mounts permission priming at the shell root once first-run and tutorial
 * gates allow the post-login soft-ask sequence to appear.
 */
import * as React from "react";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { getFrontendPlatform } from "../../platform/platform-guards";
import { useAppSelector } from "../../state/app-store";
import { useTutorial } from "../../tutorial/tutorial-service";
import {
  supportedNativePrimingPermissions,
  useNativePermissionHost,
} from "./native-permission-host";
import { PermissionPrimingModal } from "./PermissionPrimingModal";
import {
  hasPrimedPermissions,
  markPermissionsPrimed,
  PERMISSION_WALKTHROUGH_REOPEN_EVENT,
  primingWalkthroughMemory,
  resolvePrimingSet,
} from "./permission-priming";

/**
 * Mounts the permission-priming modal exactly once, right after onboarding.
 *
 * Mounted as a shell-root sibling (next to FirstRunConductorMount /
 * TutorialConductorMount) and self-gates — it renders `null` unless:
 *  - the user is authenticated (post-login; local resolves silently, cloud
 *    clears LoginView),
 *  - first-run has completed (`firstRunComplete !== false`), so the in-chat
 *    onboarding lock is already released and there is nothing to collide with,
 *  - the tutorial is not active (the chat-native tour owns the conversation
 *    right after onboarding — priming waits its turn instead of covering it),
 *  - the platform has a non-empty priming set (web is intentionally empty), and
 *  - it hasn't already been shown (persisted flag; re-trigger lives in Settings).
 *
 * It keeps walkthrough memory, so an OS prompt it already fired is never fired again (that card
 * routes to system settings), and it reopens when `primingWalkthroughMemory().reopen()` is called.
 * The sequence stays unfinished until it completes, so a restart mid-way resumes it; permissions
 * granted meanwhile drop out on the next status check.
 */
export function PermissionPrimingOverlay(): React.JSX.Element | null {
  const host = useNativePermissionHost();
  const authed = useIsAuthenticated();
  const firstRunComplete = useAppSelector((s) => s.firstRunComplete);
  const tutorial = useTutorial();

  const ids = React.useMemo(
    () =>
      resolvePrimingSet({
        supported:
          host?.supported ??
          (getFrontendPlatform() === "android"
            ? supportedNativePrimingPermissions()
            : undefined),
      }),
    [host],
  );
  const defaultMemory = React.useMemo(primingWalkthroughMemory, []);
  const memory = host?.memory ?? defaultMemory;
  const [primed, setPrimed] = React.useState<boolean>(() =>
    host?.memory ? host.memory.read().dismissed : hasPrimedPermissions(),
  );
  const [open, setOpen] = React.useState(false);

  // A reopen entry (e.g. Settings) clears the dismissal; offer the walkthrough again. It requests
  // nothing itself: every OS prompt still needs an explicit Enable tap.
  React.useEffect(() => {
    const reopen = () => setPrimed(false);
    try {
      globalThis.addEventListener?.(
        host?.reopenEvent ?? PERMISSION_WALKTHROUGH_REOPEN_EVENT,
        reopen,
      );
    } catch {
      return undefined;
    }
    return () =>
      globalThis.removeEventListener?.(
        host?.reopenEvent ?? PERMISSION_WALKTHROUGH_REOPEN_EVENT,
        reopen,
      );
  }, [host]);

  const eligible =
    authed &&
    firstRunComplete !== false &&
    tutorial.status !== "active" &&
    ids.length > 0 &&
    !primed;

  // Open the first time eligibility is satisfied; once open it stays open until
  // the sequence completes (we never yank the modal out from under the user).
  React.useEffect(() => {
    if (eligible) setOpen(true);
  }, [eligible]);

  const handleComplete = React.useCallback(() => {
    if (host?.memory) host.memory.write({ dismissed: true });
    else markPermissionsPrimed();
    setPrimed(true);
    setOpen(false);
  }, [host]);

  if (!open || primed || ids.length === 0) return null;

  return (
    <PermissionPrimingModal
      ids={ids}
      open={open}
      onComplete={handleComplete}
      memory={memory}
    />
  );
}
