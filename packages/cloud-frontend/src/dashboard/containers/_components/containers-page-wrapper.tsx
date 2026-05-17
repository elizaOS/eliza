"use client";

import { DashboardRoutePage } from "@elizaos/ui";
import type { ReactNode } from "react";

interface ContainersPageWrapperProps {
  children: ReactNode;
}

export function ContainersPageWrapper({
  children,
}: ContainersPageWrapperProps): ReactNode {
  return <DashboardRoutePage title="Containers">{children}</DashboardRoutePage>;
}
