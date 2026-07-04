/**
 * Prompt card: flat surface for clickable prompt suggestions.
 */

import { ArrowUp } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../lib/utils";

interface PromptCardProps {
  prompt: string;
  onClick?: () => void;
  className?: string;
}

export function PromptCard({ prompt, onClick, className }: PromptCardProps) {
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={onClick}
      className={cn(
        "group relative rounded-sm border border-border bg-bg-elevated p-4 text-left hover:border-border-strong hover:bg-bg-hover transition-colors",
        className,
      )}
    >
      <p className="text-sm text-muted-foreground group-hover:text-txt">
        {prompt}
      </p>
      <ArrowUp className="absolute bottom-4 right-4 h-4 w-4 text-muted-foreground group-hover:text-txt" />
    </Button>
  );
}

interface PromptCardGridProps {
  prompts: string[];
  onPromptClick?: (prompt: string) => void;
  className?: string;
}

export function PromptCardGrid({
  prompts,
  onPromptClick,
  className,
}: PromptCardGridProps) {
  return (
    <div
      className={cn("mt-6 grid grid-cols-1 md:grid-cols-3 gap-2", className)}
    >
      {prompts.map((prompt) => (
        <PromptCard
          key={prompt}
          prompt={prompt}
          onClick={() => onPromptClick?.(prompt)}
        />
      ))}
    </div>
  );
}
