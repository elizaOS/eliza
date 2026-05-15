"use client";

import { useSetPageHeader } from "@elizaos/ui";

interface AppPageWrapperProps {
  appName: string;
  children: React.ReactNode;
}

export function AppPageWrapper({ appName, children }: AppPageWrapperProps) {
  useSetPageHeader({
    title: appName,
  });

  return children;
}
