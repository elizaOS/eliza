/**
 * MCPs page wrapper that sets page header context.
 * Provides consistent header title and description for MCP servers page.
 */

"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";

interface MCPsPageWrapperProps {
  children: ReactNode;
}

export function MCPsPageWrapper({ children }: MCPsPageWrapperProps) {
  return (
    <DashboardRoutePage
      title="MCP Servers"
      description="Browse and connect to Model Context Protocol servers"
    >
      {children}
    </DashboardRoutePage>
  );
}
