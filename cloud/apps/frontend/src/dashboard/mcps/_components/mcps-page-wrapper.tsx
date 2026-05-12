/**
 * MCPs page wrapper that sets page header context.
 * Provides consistent header title and description for MCP servers page.
 */

"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { type ReactNode } from "react";

interface MCPsPageWrapperProps {
  children: ReactNode;
}

export function MCPsPageWrapper({ children }: MCPsPageWrapperProps) {
  useSetPageHeader({
    title: "MCP Servers",
    description: "Browse and connect to Model Context Protocol servers",
  });

  return children;
}
