/**
 * Dashboard page wrapper that sets page header context.
 * Provides consistent header title and description across dashboard pages.
 *
 * @param props - Dashboard wrapper configuration
 * @param props.userName - User's name to display in header description
 * @param props.children - Page content to render
 */

"use client";

import { type ReactNode } from "react";
import { useSetPageHeader } from "@/components/layout/page-header-context";

interface DashboardPageWrapperProps {
  userName: string;
  children: ReactNode;
}

export function DashboardPageWrapper({
  userName,
  children,
}: DashboardPageWrapperProps) {
  useSetPageHeader(
    {
      title: "Dashboard",
    },
    [userName],
  );

  return children;
}
