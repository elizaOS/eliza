"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { type ReactNode } from "react";

interface ContainersPageWrapperProps {
  children: ReactNode;
}

export function ContainersPageWrapper({ children }: ContainersPageWrapperProps): ReactNode {
  useSetPageHeader({ title: "Containers" }, []);
  return children;
}
