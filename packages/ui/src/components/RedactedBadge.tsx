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
import { Badge } from "./ui/badge";

export function RedactedBadge({
  className,
  testId = "redacted-badge",
}: {
  className?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      className={cn("shrink-0", className)}
    >
      <EyeOff className="size-3" aria-hidden />
      Redacted
    </Badge>
  );
}
