/**
 * Thin route-page chrome for a single application detail view. Ported from
 * `@elizaos/cloud-frontend/src/dashboard/apps/_components/single-app-page-wrapper.tsx`.
 */

import type { ReactNode } from "react";
import { DashboardRoutePage } from "../../../cloud-ui/components/layout";

interface AppPageWrapperProps {
  appName: string;
  children: ReactNode;
}

export function AppPageWrapper({ appName, children }: AppPageWrapperProps) {
  return <DashboardRoutePage title={appName}>{children}</DashboardRoutePage>;
}
