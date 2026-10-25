/** Owner-readable commands for the existing conversation choice renderer. */
import type { ApprovalAction } from "./types.ts";
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
