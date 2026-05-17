"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";

interface AppPageWrapperProps {
  appName: string;
  children: ReactNode;
}

export function AppPageWrapper({ appName, children }: AppPageWrapperProps) {
  return <DashboardRoutePage title={appName}>{children}</DashboardRoutePage>;
}
