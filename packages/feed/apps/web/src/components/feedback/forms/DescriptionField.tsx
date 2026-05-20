'use client';

import {
  cn,
  FEEDBACK_DESCRIPTION_MAX_LENGTH,
  FEEDBACK_DESCRIPTION_MIN_LENGTH,
} from '@feed/shared';
import type { FeedbackType } from './FeedbackTypeSelector';

const PLACEHOLDERS: Record<FeedbackType, string> = {
  bug: 'Describe what happened...',
  feature_request: 'Tell us what you would like to see or change...',
  performance: 'Describe the performance issue...',
};

interface DescriptionFieldProps {
  value: string;
  onChange: (value: string) => void;
  feedbackType: FeedbackType;
  maxLength?: number;
}

export function DescriptionField({
  value,
  onChange,
  feedbackType,
  maxLength = FEEDBACK_DESCRIPTION_MAX_LENGTH,
}: DescriptionFieldProps) {
  return (
    <div className="space-y-2">
      <label
        htmlFor="description"
        className="font-medium text-foreground text-sm"
      >
        Description{' '}
        <span className="text-muted-foreground text-xs">
          (required, min {FEEDBACK_DESCRIPTION_MIN_LENGTH} characters)
        </span>
      </label>
      <textarea
        id="description"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={PLACEHOLDERS[feedbackType]}
        maxLength={maxLength}
        rows={6}
        className={cn(
          'w-full rounded-lg border border-border bg-muted px-3 py-2',
          'text-foreground placeholder-muted-foreground',
          'focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[#1c9cf0]',
          'resize-none transition-colors'
        )}
      />
      <div className="flex justify-between text-muted-foreground text-xs">
        <span>Maximum {maxLength} characters</span>
        <span>
          {value.length}/{maxLength}
        </span>
      </div>
    </div>
  );
}
