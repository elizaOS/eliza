/** Notes-owned resolution; classification restricts, and never grants, effects. */
import {
  type ActionResult,
  BoundRequestOperationError,
  bindRequestOperationResult,
  canonicalNotesRequestOperation,
  checkBoundNotesOperation,
  copyBoundOperationDenial,
  getActionRoutingContext,
  type IAgentRuntime,
  type Memory,
  type NotesRequestOperation,
  READ_ONLY_VIEW_CAPABILITY_IDS,
  readTaskExtractionNotesRestriction,
  type State,
} from "@elizaos/core";

function decisionFor(
  runtime: IAgentRuntime,
  state: State | undefined,
  message: Memory | undefined,
  operation: NotesRequestOperation,
) {
  const canonicalOperation = canonicalNotesRequestOperation(operation);
  const routing = getActionRoutingContext();
  if (routing?.requestRuntime !== runtime) {
    return checkBoundNotesOperation(undefined, undefined, canonicalOperation);
  }
  const token = routing.requestOperationAttempt;
  return checkBoundNotesOperation(
    state,
    message,
    canonicalOperation,
    token,
    operation,
  );
}

export function restrictNotesAction(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  operation: NotesRequestOperation,
): ActionResult | undefined {
  const decision = decisionFor(runtime, state, message, operation);
  if (decision.allowed) return undefined;
  const result: ActionResult = {
    success: false,
    text:
      decision.code === "REQUEST_OPERATION_RESTRICTED"
        ? "This write was not performed: the current request is restricted to reading Notes. Read the requested note instead."
        : "This write was not performed: the current Notes operation is unresolved. Clarify the requested change before writing.",
    error: decision.code,
    failureProvenance: {
      kind: "handler_error",
      boundary: "handler",
      code: decision.code,
      retryable: false,
    },
    data: {
      code: decision.code,
      acceptance: "rejected",
      executionStatus: "not_started",
      executed: false,
      retryable: false,
    },
  };
  const attempt = getActionRoutingContext()?.requestOperationAttempt;
  if (attempt) bindRequestOperationResult(result, attempt);
  return copyBoundOperationDenial(decision, result, attempt);
}

/** Secondary service boundary for agent-driven capabilities and nested calls.
 * No ambient action means this conversational restriction is not applicable:
 * existing direct UI/service admission is unchanged, not newly authorized.
 */
export function assertNotesServiceMutation(
  runtime: IAgentRuntime | undefined,
  operation: NotesRequestOperation,
): void {
  const routing = getActionRoutingContext();
  if (!routing) return;
  const decision = runtime
    ? decisionFor(
        runtime,
        routing.requestState,
        routing.requestMessage,
        operation,
      )
    : checkBoundNotesOperation(undefined, undefined, operation);
  if (!decision.allowed) throw new BoundRequestOperationError(decision);
}

/** Run before either server or frontend agent-capability delivery. */
export function assertNotesAgentViewOperation(
  capability: string,
  _params: Record<string, unknown> | undefined,
  context: { runtime: IAgentRuntime },
): void {
  const routing = getActionRoutingContext();
  if (!routing) return;
  // Preserve the broker's canonical observations; these cannot request a
  // Notes mutation. Other existing broker authority checks still apply.
  if (READ_ONLY_VIEW_CAPABILITY_IDS.has(capability)) return;
  // The owner maps its declared capability contract, not per-request tools.
  const operations: Record<string, NotesRequestOperation> = {
    "get-notes": "list",
    "get-note": "get",
    "get-notes-trash": "list",
    "create-note": "create",
    "update-note": "update",
    "delete-note": "delete",
    "clear-notes": "delete",
    "restore-note": "update",
  };
  const operation = operations[capability];
  if (
    !operation &&
    readTaskExtractionNotesRestriction(
      routing.requestState,
      routing.requestMessage,
      context.runtime,
    ) === "mutation_requested"
  ) {
    // This restrictive layer adds no permission or prohibition here. The
    // existing role/manifest/foreground/target broker rules remain required.
    // Any service-backed mutation is checked again at its resolved operation.
    return;
  }
  // A generic DOM operation has no resolved Notes effect. Never guess that
  // clicking a control is a read; it cannot receive outside-request proof.
  const decision = operation
    ? decisionFor(
        context.runtime,
        routing.requestState,
        routing.requestMessage,
        operation,
      )
    : checkBoundNotesOperation(undefined, undefined, "create");
  if (!decision.allowed) throw new BoundRequestOperationError(decision);
}
