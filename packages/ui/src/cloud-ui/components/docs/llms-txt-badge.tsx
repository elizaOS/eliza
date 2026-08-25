"use client";

/**
 * Badge linking to the llms.txt for the current docs page.
 */
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Badge } from "../../../components/ui/badge";

function DocsBadgeLink({
  href,
  children,
  title,
}: {
  href: string;
  children: ReactNode;
  title: string;
}) {
  return (
    <Badge asChild variant="outline">
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    </Badge>
  );
}

export function LlmsTxtBadge() {
  const indexPath = "/.well-known/llms.txt";
  const fullPath = "/.well-known/llms-full.txt";
  const pathname = useLocation().pathname;

  // Only show this control on docs routes.
  if (!pathname?.startsWith("/docs")) return null;

  // On the docs landing page, only show a single llms.txt link (no full pack).
  const isDocsLanding = pathname === "/docs" || pathname === "/docs/";
  if (isDocsLanding) {
    return (
      <DocsBadgeLink
        href={indexPath}
        title="LLM context index for Cursor / ChatGPT (llms.txt)"
      >
        llms.txt
      </DocsBadgeLink>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <DocsBadgeLink
        href={indexPath}
        title="LLM context index for Cursor / ChatGPT (llms.txt)"
      >
        llms.txt
      </DocsBadgeLink>
      <DocsBadgeLink
        href={fullPath}
        title="Full docs pack for Cursor / ChatGPT (llms-full.txt)"
      >
        llms-full
      </DocsBadgeLink>
    </div>
  );
}
