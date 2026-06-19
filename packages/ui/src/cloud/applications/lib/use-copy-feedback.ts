/**
 * Tiny "copied!" flag helper. Ported verbatim from
 * `@elizaos/cloud-frontend/src/hooks/use-copy-feedback.ts`.
 */

import { useCallback, useState } from "react";

export function useCopyFeedback(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false);

  const markCopied = useCallback(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), timeoutMs);
  }, [timeoutMs]);

  return { copied, markCopied };
}
