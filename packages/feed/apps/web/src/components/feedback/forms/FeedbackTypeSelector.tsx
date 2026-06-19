"use client";

import { cn, type FeedbackType } from "@feed/shared";

export type { FeedbackType };

interface FeedbackTypeConfig {
  type: FeedbackType;
  title: string;
  description: string;
}

const FEEDBACK_TYPES: FeedbackTypeConfig[] = [
  {
    type: "bug",
    title: "Report a Bug",
    description:
      "Help us fix issues by describing what happened and how to reproduce it.",
  },
  {
    type: "feature_request",
    title: "Feature Request",
    description:
      "Tell us what you would like to see or change. How strongly do you feel about this?",
  },
  {
    type: "performance",
    title: "Performance Issue",
    description:
      "Report performance issues like lag, crashes, or graphical glitches.",
  },
];

interface FeedbackTypeSelectorProps {
  onSelect: (type: FeedbackType) => void;
}

export function FeedbackTypeSelector({ onSelect }: FeedbackTypeSelectorProps) {
  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-foreground text-sm">
        What type of feedback would you like to submit?
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        {FEEDBACK_TYPES.map(({ type, title, description }) => (
          <button
            type="button"
            key={type}
            onClick={() => onSelect(type)}
            className={cn(
              "flex flex-col gap-2 rounded-lg border border-border bg-card p-4",
              "transition-all hover:border-[#1c9cf0] hover:bg-muted/50",
              "text-left",
            )}
          >
            <div className="font-semibold text-foreground text-sm">{title}</div>
            <div className="text-muted-foreground text-xs">{description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function getFeedbackTypeConfig(type: FeedbackType): FeedbackTypeConfig {
  const config = FEEDBACK_TYPES.find((c) => c.type === type);
  // Type guard: FEEDBACK_TYPES always has the bug type, so this is safe
  return config ?? FEEDBACK_TYPES[0]!;
}
