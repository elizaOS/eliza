import {
  CALENDAR_NAMED_READ_CAPABILITY,
  type NamedTargetOperation,
} from "@elizaos/contracts";
import {
  CALENDAR_CAPABILITY,
  type CalendarOperation,
  calendarTarget,
  validateCalendarOperation,
  validateCalendarResult,
} from "@elizaos/plugin-assistant/device-calendar-contract";
import {
  validateForegroundReviewOperation,
  validateForegroundReviewResult,
} from "@elizaos/plugin-assistant/device-foreground-review";
export interface NamedCalendarReadProvider {
  executeAgent(input: {
    operation: Extract<CalendarOperation, { type: "calendar_read_selected" }>;
    operationId: string;
    journalIdentity?: { scope: string; proposalId: string };
  }): Promise<{ status: string; result?: unknown }>;
  cancelAgent(input: { operationId: string }): Promise<unknown>;
}
export type NamedCalendarReadContext = {
  view: string;
  sensitive?: boolean;
  selectedObject?: unknown;
};
/** Readiness only: the provider must still validate this target and obtain Share. */
export function namedCalendarReadTarget(context: NamedCalendarReadContext) {
  if (context.view !== "calendar" || context.sensitive) return;
  const selected = context.selectedObject as
    | Record<string, unknown>
    | undefined;
  if (!selected || selected.kind !== "calendar-event") return;
  try {
    return calendarTarget({
      sourceId: selected.accountId,
      sourceRevision: selected.sourceRevision,
      eventId: selected.id,
      revision: selected.revision,
    });
  } catch {
    return;
  }
}
/** Existing owner-selected Calendar event + its existing native/browser Share dialog.
 * No calendar listing/search, implicit selection, write or provider substitution. */
export async function executeNamedCalendarRead(
  provider: NamedCalendarReadProvider,
  operation: NamedTargetOperation,
  operationId: string,
  context: NamedCalendarReadContext,
  capabilities: readonly string[],
  signal: AbortSignal,
  current: () => void,
  journalIdentity?: { scope: string; proposalId: string },
) {
  current();
  signal.throwIfAborted();
  const requested = validateForegroundReviewOperation(operation);
  if (
    requested.type !== "calendar_named" ||
    requested.action !== "read" ||
    ![CALENDAR_NAMED_READ_CAPABILITY, CALENDAR_CAPABILITY].every((cap) =>
      capabilities.includes(cap),
    )
  )
    throw Error("Named Calendar read capability unavailable");
  const fail = (summary: string) => ({ status: "failed" as const, summary });
  const target = namedCalendarReadTarget(context);
  if (!target)
    return fail(
      "Choose the exact matching event in Calendar before sharing it. Nothing was shared or changed.",
    );
  const exact = validateCalendarOperation({
    type: "calendar_read_selected",
    target,
  });
  if (exact.type !== "calendar_read_selected")
    throw Error("Named read resolved to an unsupported operation");
  const cancel = () => {
    void provider.cancelAgent({ operationId }).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let receipt: { status: string; result?: unknown };
  try {
    current();
    signal.throwIfAborted();
    receipt = await provider.executeAgent({
      operation: exact,
      operationId,
      ...(journalIdentity ? { journalIdentity } : {}),
    });
    current();
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (receipt.status !== "applied")
    return fail(
      "The event was not shared. Its selection, access or review changed; nothing was changed.",
    );
  const record = validateCalendarResult(exact, receipt.result);
  if (record.kind !== "calendar_read_selected" || !record.fields)
    throw Error("Fresh Calendar snapshot unavailable");
  const fold = (value: string) => value.normalize("NFKC").toLowerCase();
  if (!fold(record.fields.title).includes(fold(requested.name)))
    return fail(
      "The selected event does not match the requested name. Nothing was shared or changed.",
    );
  current();
  signal.throwIfAborted();
  return {
    status: "succeeded" as const,
    summary:
      "Shared the matching event you chose. Its requested update still requires a separate review.",
    foregroundResult: validateForegroundReviewResult(
      requested,
      {
        version: 1,
        kind: "calendar_named",
        action: "read",
        name: requested.name,
        basis: "owner-chosen",
        operation: exact,
        record,
      },
      capabilities,
    ),
  };
}
