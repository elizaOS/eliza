/**
 * Visual twin of the shared route header for the focused preview. The app
 * header's navigation module boots the full shell graph, which this fixture
 * deliberately avoids; production Notes continues to import the real header.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/button";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

export function ViewHeader({
  title,
  onBack,
  backLabel = "Back to launcher",
  showBack = true,
  right,
  className,
}: {
  title: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  showBack?: boolean;
  right?: ReactNode;
  className?: string;
}) {
  const handleBack = onBack ?? (() => window.history.back());
  const back = useAgentElement<HTMLButtonElement>({
    id: "view-back",
    role: "button",
    label: backLabel,
    description: "Return to the launcher",
    onActivate: handleBack,
  });

  return (
    <header
      data-testid="view-header"
      className={`relative flex min-h-14 shrink-0 items-center justify-between gap-1 px-3 py-2.5 sm:gap-2 sm:px-4 ${className ?? ""}`}
    >
      {showBack ? (
        <Button
          ref={back.ref}
          variant="ghost"
          size="icon-lg"
          onClick={handleBack}
          aria-label={backLabel}
          className="keyboard-focus-surface -m-1"
          {...back.agentProps}
        >
          <ArrowLeft className="size-5" aria-hidden />
        </Button>
      ) : (
        <span aria-hidden />
      )}
      <h1 className="pointer-events-none absolute inset-x-0 mx-auto max-w-[calc(100%-6rem)] truncate px-12 text-center text-lg font-semibold tracking-tight text-txt-strong">
        {title}
      </h1>
      {right ? (
        <div className="relative z-10">{right}</div>
      ) : (
        <span aria-hidden />
      )}
    </header>
  );
}
