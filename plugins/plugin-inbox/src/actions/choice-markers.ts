import type { TriageEntry } from "../inbox/types.js";

function choiceLabelText(value: string): string {
  return value
    .replace(/[\r\n=]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function appendInboxDraftChoiceMarker(
  text: string,
  entryId: string,
): string {
  return `${text}
[CHOICE:inbox-draft-${entryId} id=${entryId}]
inbox approve ${entryId}=Send
inbox edit ${entryId}=Edit
inbox discard ${entryId}=Discard
[/CHOICE]`;
}

export function appendInboxTriageChoiceMarkers(
  text: string,
  entries: ReadonlyArray<TriageEntry>,
): string {
  if (entries.length === 0) return text;
  const blocks = entries.slice(0, 5).map((entry) => {
    const sender = choiceLabelText(entry.senderName ?? entry.channelName);
    return `[CHOICE:inbox-thread-${entry.id} id=${entry.id}]
inbox reply ${entry.id}=Reply to ${sender}
inbox snooze ${entry.id}=Snooze
inbox archive ${entry.id}=Archive
[/CHOICE]`;
  });
  return `${text}
${blocks.join("\n")}`;
}
