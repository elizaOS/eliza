"use client";

import { HelpCircle } from "lucide-react";

interface TutorialHelpButtonProps {
  onClick: () => void;
}

export function TutorialHelpButton({ onClick }: TutorialHelpButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
      aria-label="Restart tutorial"
      title="Tutorial"
    >
      <HelpCircle size={14} />
    </button>
  );
}
