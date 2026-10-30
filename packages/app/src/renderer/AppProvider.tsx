/** Canonical host configuration for the shared application/session provider. */

import type { BrandingConfig } from "@elizaos/ui";
import { AppProvider as SharedAppProvider } from "@elizaos/ui/app/AppProvider";
import { type ReactNode, useEffect } from "react";
import { canonicalStartupPorts } from "./startup/canonical-startup-host";
export function AppProvider({
  children,
  branding,
}: {
  children: ReactNode;
  branding?: Partial<BrandingConfig>;
}) {
  // The canonical app's explicitly gated SIWE test harness stays with its host.
  useEffect(() => {
    void import("../dev/e2e-wallet").then(({ installE2eWalletIfRequested }) =>
      installE2eWalletIfRequested(),
    );
  }, []);
  return (
    <SharedAppProvider branding={branding} startupHost={canonicalStartupPorts}>
      {children}
    </SharedAppProvider>
  );
}
