// LifeOps setup-gate dismissal persistence (localStorage) split out of
// LifeOpsSetupGate.tsx so that file exports only the React component and stays
// Fast-Refresh-compatible (Vite full-reloads a component file that also exports
// a hook / plain functions / constants). The dismiss flag is persisted under
// LIFEOPS_SETUP_GATE_DISMISSED_KEY.

import { useCallback, useState } from "react";

export const LIFEOPS_SETUP_GATE_DISMISSED_KEY =
  "eliza:lifeops-setup-gate-dismissed";

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(LIFEOPS_SETUP_GATE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDismissed(): void {
  try {
    localStorage.setItem(LIFEOPS_SETUP_GATE_DISMISSED_KEY, "1");
  } catch {
    // ignore
  }
}

export function clearLifeOpsSetupGateDismissed(): void {
  try {
    localStorage.removeItem(LIFEOPS_SETUP_GATE_DISMISSED_KEY);
  } catch {
    // ignore
  }
}

export function useLifeOpsSetupGate() {
  const [dismissed, setDismissed] = useState<boolean>(loadDismissed);

  const dismiss = useCallback(() => {
    saveDismissed();
    setDismissed(true);
  }, []);

  const reset = useCallback(() => {
    clearLifeOpsSetupGateDismissed();
    setDismissed(false);
  }, []);

  return { dismissed, dismiss, reset };
}
