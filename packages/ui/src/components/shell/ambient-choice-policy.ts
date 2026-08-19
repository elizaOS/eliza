/**
 * Keeps reminder actions out of passive Home transcripts while preserving
 * every other interactive choice and the canonical full-chat experience.
 */

import { findChoiceRegions } from "../chat/message-choice-parser";

interface AmbientMessage {
  role: string;
  content: string;
  attachments?: readonly unknown[];
  failureKind?: unknown;
  secretRequest?: unknown;
}

const AMBIENT_REMINDER_SCOPE = "lifeops-reminder";

export function withoutAmbientReminderChoices(content: string): string {
  const removable = findChoiceRegions(content).filter(
    ({ scope }) => scope === AMBIENT_REMINDER_SCOPE,
  );
  if (removable.length === 0) return content;

  let cursor = 0;
  let result = "";
  for (const region of removable) {
    result += content.slice(cursor, region.start);
    cursor = region.end;
  }
  result += content.slice(cursor);
  return result.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function shouldDisplayAmbientMessage(message: AmbientMessage): boolean {
  if (message.role !== "assistant" || message.content === "") return true;
  if (withoutAmbientReminderChoices(message.content).trim()) return true;
  return Boolean(
    message.attachments?.length || message.failureKind || message.secretRequest,
  );
}

export function selectAmbientMessages<T extends AmbientMessage>(
  messages: readonly T[],
): T[] {
  return messages.filter(shouldDisplayAmbientMessage);
}
