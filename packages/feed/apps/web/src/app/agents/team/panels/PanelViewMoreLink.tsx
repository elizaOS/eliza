"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";

interface PanelViewMoreLinkProps {
  href: string;
  children: React.ReactNode;
}

/**
 * Consistent redirect button used across all sidebar panels
 */
export function PanelViewMoreLink({ href, children }: PanelViewMoreLinkProps) {
  return (
    <Link
      href={href}
      className="flex items-center justify-center gap-2 rounded-lg border border-border p-3 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
    >
      <ExternalLink size={14} />
      {children}
    </Link>
  );
}
