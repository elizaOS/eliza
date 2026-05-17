"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";

interface ElizaAgentsPageWrapperProps {
  children: ReactNode;
}

export function ElizaAgentsPageWrapper({
  children,
}: ElizaAgentsPageWrapperProps): ReactNode {
  return <DashboardRoutePage title="Instances">{children}</DashboardRoutePage>;
}
