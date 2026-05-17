"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";

interface AppsPageWrapperProps {
  children: ReactNode;
}

export function AppsPageWrapper({ children }: AppsPageWrapperProps) {
  return <DashboardRoutePage title="My Apps">{children}</DashboardRoutePage>;
}
