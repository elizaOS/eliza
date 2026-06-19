/**
 * MCPs page wrapper that sets page header context.
 * Provides consistent header title and description for MCP servers page.
 */

"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";
import { useT } from "@/providers/I18nProvider";

interface MCPsPageWrapperProps {
  children: ReactNode;
}

export function MCPsPageWrapper({ children }: MCPsPageWrapperProps) {
  const t = useT();
  return (
    <DashboardRoutePage
      title={t("cloud.mcps.pageTitle", { defaultValue: "MCP Servers" })}
      description={t("cloud.mcps.pageDescription", {
        defaultValue: "Browse and connect to Model Context Protocol servers",
      })}
    >
      {children}
    </DashboardRoutePage>
  );
}
