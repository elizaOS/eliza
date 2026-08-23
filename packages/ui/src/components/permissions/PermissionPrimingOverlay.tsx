/**
 * Mounts permission priming at the shell root once first-run and tutorial
 * gates allow the post-login soft-ask sequence to appear.
 */
import * as React from "react";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { useAppSelector } from "../../state";
import { useTutorial } from "../../tutorial/tutorial-service";
import { PermissionPrimingModal } from "./PermissionPrimingModal";
import {
  hasPrimedPermissions,
  markPermissionsPrimed,
  resolvePrimingSet,
} from "./permission-priming";

/**
 * Mounts the permission-priming modal exactly once, right after onboarding.
 *
 * Mounted as a shell-root sibling (next to FirstRunConductorMount /
 * TutorialConductorMount) and self-gates — it renders `null` unless:
 *  - the user is authenticated (post-login; local resolves silently, cloud
 *    clears LoginView),
 *  - this surface observed first-run incomplete and then complete, so restoring
 *    an existing session or opening a second desktop window cannot summon an
 *    onboarding modal over the requested destination,
 *  - the tutorial is not active (the chat-native tour owns the conversation
 *    right after onboarding — priming waits its turn instead of covering it),
 *  - the platform has a non-empty priming set (web is intentionally empty), and
 *  - it hasn't already been shown (persisted flag; re-trigger lives in Settings).
 */
export function PermissionPrimingOverlay(): React.JSX.Element | null {
  const authed = useIsAuthenticated();
  const firstRunComplete = useAppSelector((s) => s.firstRunComplete);
  const tutorial = useTutorial();

  const ids = React.useMemo(() => resolvePrimingSet(), []);
  const [primed, setPrimed] = React.useState<boolean>(hasPrimedPermissions);
  const [open, setOpen] = React.useState(false);

  // `firstRunComplete === true` is persisted and restored for every new
  // renderer surface. It is not evidence that onboarding just completed in
  // this surface. Remember an actual incomplete state so only the surface that
  // hosted onboarding may auto-open the post-onboarding soft ask. Explicit
  // re-entry remains available from Settings -> Permissions.
  const observedIncompleteFirstRunRef = React.useRef(
    firstRunComplete === false,
  );
  if (firstRunComplete === false) {
    observedIncompleteFirstRunRef.current = true;
  }
  const completedFirstRunInThisSurface =
    observedIncompleteFirstRunRef.current && firstRunComplete === true;

  const eligible =
    authed &&
    completedFirstRunInThisSurface &&
    !tutorial.active &&
    ids.length > 0 &&
    !primed;

  // Open the first time eligibility is satisfied; once open it stays open until
  // the sequence completes (we never yank the modal out from under the user).
  React.useEffect(() => {
    if (eligible) setOpen(true);
  }, [eligible]);

  const handleComplete = React.useCallback(() => {
    markPermissionsPrimed();
    setPrimed(true);
    setOpen(false);
  }, []);

  if (!open || primed || ids.length === 0) return null;

  return (
    <PermissionPrimingModal ids={ids} open={open} onComplete={handleComplete} />
  );
}
