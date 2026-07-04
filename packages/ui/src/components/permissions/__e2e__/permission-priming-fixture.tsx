/**
 * Fixture for the permission-priming e2e (run-permission-priming-e2e.mjs).
 * Mounts the REAL {@link PermissionPrimingModal} on its LIVE path (the real
 * `usePermissionPriming` hook + client-permissions registry). The runner
 * esbuild-stubs the `api/client` singleton so `getPermission` / `requestPermission`
 * are deterministic and need no backend — `window.__deny` scripts a denial for a
 * given permission id.
 *
 * The app store is seeded directly (a minimal `t`) rather than via MockAppProvider,
 * keeping the bundle graph to the modal's own dependencies. `onComplete` stamps
 * `document.body[data-primed]` so the runner can prove the sequence completed.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { AppContextValue } from "../../../state/internal";
import { seedAppValue } from "../../../state/app-store";
import { PermissionPrimingModal } from "../PermissionPrimingModal";

// Minimal store: the modal only reads `s.t`. Returns the provided defaultValue
// (with {{name}} interpolation) so real copy renders in the screenshots.
seedAppValue({
  t: (key: string, values?: Record<string, unknown>) => {
    const raw = (values?.defaultValue as string | undefined) ?? key;
    return raw.replace(/\{\{(\w+)\}\}/g, (_m, name) =>
      String(values?.[name] ?? "Eliza"),
    );
  },
} as unknown as AppContextValue);

function Fixture(): React.JSX.Element {
  return (
    <PermissionPrimingModal
      ids={["microphone", "location", "notifications"]}
      open
      onComplete={() => {
        document.body.setAttribute("data-primed", "1");
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
