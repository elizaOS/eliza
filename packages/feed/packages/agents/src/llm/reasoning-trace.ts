const THINK_BLOCK_PATTERN =
  /<(?:think|thinking|thought)>([\s\S]*?)<\/(?:think|thinking|thought)>/gi;

export function extractReasoningTrace(response: string): string | undefined {
  if (!response) {
    return undefined;
  }

  const fragments: string[] = [];
  for (const match of response.matchAll(THINK_BLOCK_PATTERN)) {
    const content = match[1]?.trim();
    if (content) {
      fragments.push(content);
    }
  }

  if (fragments.length === 0) {
    return undefined;
  }

  const normalized = fragments.join('\n\n').replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

export function buildReasoningTraceMetadata(response: string): {
  rawReasoningTrace?: string;
  reasoningAvailable: boolean;
  reasoningSource: string;
  traceVisibility: 'public' | 'private';
} {
  const rawReasoningTrace = extractReasoningTrace(response);
  return {
    rawReasoningTrace,
    reasoningAvailable: Boolean(rawReasoningTrace),
    reasoningSource: rawReasoningTrace ? 'captured-trace' : 'none',
    traceVisibility: 'public',
  };
}
