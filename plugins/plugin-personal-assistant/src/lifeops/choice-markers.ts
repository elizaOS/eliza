import type { ApprovalAction } from "./approval-queue.types.js";

export function buildApprovalChoiceText(input: {
  requestId: string;
  reason: string;
  action: ApprovalAction;
}): string {
  return `${input.reason}
[CHOICE:approval-${input.requestId} id=${input.requestId}]
approve ${input.requestId}=Approve
reject ${input.requestId}=Deny
[/CHOICE]`;
}

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
