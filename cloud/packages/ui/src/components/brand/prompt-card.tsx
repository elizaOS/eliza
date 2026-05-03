/**
 * Prompt card component displaying interactive prompt suggestions.
 * Used in landing page with hover effects and click handling.
 *
 * @param props - Prompt card configuration
 * @param props.prompt - Prompt text to display
 * @param props.onClick - Optional callback when card is clicked
 */

import { ArrowUp } from "lucide-react";
import { cn } from "../../lib/utils";

interface PromptCardProps {
  prompt: string;
  onClick?: () => void;
  className?: string;
}

export function PromptCard({ prompt, onClick, className }: PromptCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative bg-black/40 border border-white/10 p-4 text-left hover:border-white/30 transition-all",
        className,
      )}
    >
      <p className="text-sm text-white/70 group-hover:text-white/90">{prompt}</p>
      <ArrowUp className="absolute bottom-4 right-4 h-4 w-4 text-white/40 group-hover:text-white/70" />
    </button>
  );
}

// Grid of prompt cards
interface PromptCardGridProps {
  prompts: string[];
  onPromptClick?: (prompt: string) => void;
  className?: string;
}

export function PromptCardGrid({ prompts, onPromptClick, className }: PromptCardGridProps) {
  return (
    <div className={cn("mt-6 grid grid-cols-1 md:grid-cols-3 gap-2", className)}>
      {prompts.map((prompt, index) => (
        <PromptCard key={index} prompt={prompt} onClick={() => onPromptClick?.(prompt)} />
      ))}
    </div>
  );
}
