"use client";

import { useSetPageHeader } from "@elizaos/cloud-ui";
import { type ReactNode } from "react";

interface AppsPageWrapperProps {
  children: ReactNode;
}

export function AppsPageWrapper({ children }: AppsPageWrapperProps) {
  useSetPageHeader({ title: "My Apps" }, []);
  return children;
}
