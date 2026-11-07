/**
 * Choice marker helpers for owner approval and check-in responses. These strings
 * are intentionally planner-readable because the chat UI sends the selected
 * command back as owner text instead of invoking a private callback API.
 */

export { buildApprovalChoiceText } from "@elizaos/plugin-assistant";

export function appendCheckinAckChoiceMarker(
  summaryText: string,
  args: { reportId: string; kind: "morning" | "night" },
): string {
  const trimmed = summaryText.trimEnd();
  return `${trimmed}
[CHOICE:checkin-${args.reportId} id=${args.reportId}]
All good=All good
details ${args.reportId}=Show details
snooze ${args.reportId}=Snooze
[/CHOICE]`;
}
