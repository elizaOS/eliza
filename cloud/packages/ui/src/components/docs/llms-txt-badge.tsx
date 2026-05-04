"use client";

import { useLocation } from "react-router-dom";

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
      <a
        href={indexPath}
        className="text-xs text-white/70 hover:text-white transition-colors px-2 py-1 border border-white/10 bg-white/5"
        title="LLM context index for Cursor / ChatGPT (llms.txt)"
        target="_blank"
        rel="noopener noreferrer"
      >
        llms.txt
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={indexPath}
        className="text-xs text-white/70 hover:text-white transition-colors px-2 py-1 border border-white/10 bg-white/5"
        title="LLM context index for Cursor / ChatGPT (llms.txt)"
        target="_blank"
        rel="noopener noreferrer"
      >
        llms.txt
      </a>
      <a
        href={fullPath}
        className="text-xs text-white/70 hover:text-white transition-colors px-2 py-1 border border-white/10 bg-white/5"
        title="Full docs pack for Cursor / ChatGPT (llms-full.txt)"
        target="_blank"
        rel="noopener noreferrer"
      >
        llms-full
      </a>
    </div>
  );
}
