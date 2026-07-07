/**
 * Badge marking content served as a PII-scrubbed (redacted) variant (#14781).
 * The server decides redaction and stamps `redacted: true` on the DTO
 * (transcript summaries/records, chat attachments, meeting sessions); this
 * badge only displays that flag — the client never scrubs or derives
 * redaction itself. Kept as one shared component so every surface renders the
 * same, recognizable marker.
 */

import { EyeOff } from "lucide-react";
import { cn } from "../lib/utils";

export function RedactedBadge({
  className,
  testId = "redacted-badge",
}: {
  className?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted",
        className,
      )}
    >
      <EyeOff className="h-3 w-3" aria-hidden />
      Redacted
    </span>
  );
}
