"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { type ReactNode } from "react";

interface ElizaAgentsPageWrapperProps {
  children: ReactNode;
}

export function ElizaAgentsPageWrapper({ children }: ElizaAgentsPageWrapperProps): ReactNode {
  useSetPageHeader({ title: "Instances" }, []);
  return children;
}
