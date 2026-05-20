'use client';

import { AlertCircle, Check } from 'lucide-react';

interface FeedbackMessagesProps {
  error: string | null;
  warning: string | null;
  success: boolean;
}

export function FeedbackMessages({
  error,
  warning,
  success,
}: FeedbackMessagesProps) {
  if (!error && !warning && !success) {
    return null;
  }

  return (
    <div className="px-4">
      {error && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-2 border-destructive bg-sidebar-accent/30 p-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="text-destructive text-xs">{error}</span>
        </div>
      )}
      {warning && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-2 border-amber-500 bg-sidebar-accent/30 p-2">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="text-amber-500 text-xs">Sent · {warning}</span>
        </div>
      )}
      {success && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-2 border-emerald-500 bg-sidebar-accent/30 p-2">
          <Check className="h-4 w-4 shrink-0 text-emerald-500" />
          <span className="text-emerald-500 text-xs">Message sent!</span>
        </div>
      )}
    </div>
  );
}
