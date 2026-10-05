/** Canonical brief/message identity; provider ids alone cannot identify a mailbox. */
export function gmailBriefSourceId(args: {
  agentId: string;
  accountId: string;
  externalId: string;
}): string {
  return `${args.agentId}:${args.accountId}:gmail:${args.externalId}`;
}
