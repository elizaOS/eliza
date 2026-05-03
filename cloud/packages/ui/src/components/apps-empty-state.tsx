"use client";

import type { ReactNode } from "react";
import { EmptyState } from "./empty-state";

interface AppsEmptyStateProps {
  /** Override the default agent-first messaging if needed. */
  description?: string;
  /** Optional CTA — typically <CreateAppButton /> or an "Advanced ▾" expander. */
  action?: ReactNode;
}

export function AppsEmptyState({ description, action }: AppsEmptyStateProps) {
  return (
    <EmptyState title="No apps yet" description={description} variant="minimal" action={action} />
  );
}
