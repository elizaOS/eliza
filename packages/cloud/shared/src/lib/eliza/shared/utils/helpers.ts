const recentOpeningsByRoom = new Map<string, Set<string>>();

const AI_SPEAK_RE = /\b(as an ai|as a language model)\b/i;

export function containsAISpeak(text: string): boolean {
  return AI_SPEAK_RE.test(text);
}

export function removeAISpeak(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !containsAISpeak(sentence))
    .join(" ")
    .trimStart();
}

export function isRepetitiveGreeting(text: string): boolean {
  return /^(hey|hello|hi)(?:[!.]*|\s+there[!.]*)$/i.test(text.trim());
}

export function cleanPrompt(text: string): string {
  return text
    .trimStart()
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "\n");
}

export function isRepeatedOpening(roomId: string, text: string): boolean {
  return recentOpeningsByRoom.get(roomId)?.has(text) ?? false;
}

export function trackOpening(roomId: string, text: string): void {
  let openings = recentOpeningsByRoom.get(roomId);
  if (!openings) {
    openings = new Set<string>();
    recentOpeningsByRoom.set(roomId, openings);
  }
  openings.add(text);
}

type AttachmentLike = { url?: unknown };
type ResultLike = { data?: { attachments?: AttachmentLike[] } };

export function extractAttachments(results: ResultLike[]): { url: string }[] {
  return results.flatMap((result) =>
    (result.data?.attachments ?? [])
      .map((attachment) => attachment.url)
      .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url))
      .map((url) => ({ url })),
  );
}
