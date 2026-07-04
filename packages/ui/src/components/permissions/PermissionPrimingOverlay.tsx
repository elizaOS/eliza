import * as React from "react";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { useAppSelector } from "../../state";
import { useTutorial } from "../pages/tutorial/tutorial-controller";
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
 * TutorialOverlay) and self-gates — it renders `null` unless:
 *  - the user is authenticated (post-login; local resolves silently, cloud
 *    clears LoginView),
 *  - first-run has completed (`firstRunComplete !== false`), so the in-chat
 *    onboarding lock is already released and there is nothing to collide with,
 *  - the tutorial is not active (never stack two full-screen surfaces — a chosen
 *    tour runs first, then priming),
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

  const eligible =
    authed &&
    firstRunComplete !== false &&
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
