/**
 * Dashboard page wrapper that sets page header context.
 * Provides consistent header title and description across dashboard pages.
 *
 * @param props - Dashboard wrapper configuration
 * @param props.children - Page content to render
 */

"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";

interface DashboardPageWrapperProps {
  children: ReactNode;
}

export function DashboardPageWrapper({ children }: DashboardPageWrapperProps) {
  return <DashboardRoutePage title="Dashboard">{children}</DashboardRoutePage>;
}
