/**
 * MCPs page wrapper that sets page header context.
 * Provides consistent header title and description for MCP servers page.
 */

"use client";

import { type ReactNode } from "react";
import { useSetPageHeader } from "@/components/layout/page-header-context";

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
