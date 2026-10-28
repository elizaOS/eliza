/** Owner-scoped mailbox changes. The host owns provider review, dispatch and reconciliation. */
import { managedGmailHostTransport } from "./managed-gmail-transport.ts";
export type ManagedGmailMutation = {
  messageId: string;
  kind: "archive" | "trash" | "mark-read" | "mark-unread";
  requestId: string;
};
/**
 * Archive, trash and read-state changes have no qualified host acceptance yet.
 * They stay off, even when the operation broker is configured, unless the host
 * also sets this flag.
 */
export const MANAGED_GMAIL_MAILBOX_CHANGES_FLAG =
  "ELIZA_MANAGED_GMAIL_MAILBOX_CHANGES_ENABLED";
export function managedGmailMailboxChangesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[MANAGED_GMAIL_MAILBOX_CHANGES_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true";
}
export function managedGmailManager(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
) {
  if (!managedGmailMailboxChangesEnabled(env)) return undefined;
  const call = managedGmailHostTransport(
    env.ELIZA_MANAGED_GMAIL_OPERATION_BROKER,
    env.ELIZA_API_TOKEN,
    request,
  );
  if (!call) return undefined;
  return async (input: ManagedGmailMutation) => {
    if (
      !/^alpha-gmail:[a-f0-9]{64}:[A-Za-z0-9_-]{1,160}$/.test(
        input.messageId,
      ) ||
      !["archive", "trash", "mark-read", "mark-unread"].includes(input.kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        input.requestId,
      )
    )
      throw Error("Select an exact Gmail message and current owner operation.");
    const result = (await call({ mailbox: input })).mailbox as
      | Record<string, unknown>
      | undefined;
    if (
      !result ||
      result.requestId !== input.requestId ||
      result.kind !== input.kind ||
      result.messageId !== input.messageId ||
      typeof result.ok !== "boolean"
    )
      throw Error(
        "The mailbox result could not be verified. Check its saved receipt before another change.",
      );
    if (result.ok !== true)
      return {
        ok: false,
        reason:
          "The mailbox change was not confirmed. Check its saved receipt before another change.",
      };
    return { ok: true };
  };
}
