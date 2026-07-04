/**
 * Dispatch layer for agent-generated UI: routes an ElizaGenUiAction to its
 * handler, gated by the action-name allowlist so a generated component can only
 * fire permitted actions.
 */
import { isElizaGenUiActionAllowed } from "./genui-action-registry";
import type {
  ElizaGenUiAction,
  ElizaGenUiActionContext,
  ElizaGenUiActionHandler,
  ElizaGenUiActionResult,
} from "./types";

export class ElizaGenUiActionError extends Error {
  readonly action: ElizaGenUiAction;

  constructor(message: string, action: ElizaGenUiAction) {
    super(message);
    this.name = "ElizaGenUiActionError";
    this.action = action;
  }
}

export function createElizaGenUiPrefixActionHandler(
  prefixes: readonly string[],
  handle: (
    action: ElizaGenUiAction,
    context: ElizaGenUiActionContext,
  ) => Promise<ElizaGenUiActionResult>,
): ElizaGenUiActionHandler {
  return {
    canHandle(eventName) {
      return prefixes.some((prefix) => eventName.startsWith(prefix));
    },
    handle,
  };
}

export async function routeElizaGenUiAction(
  action: ElizaGenUiAction,
  context: ElizaGenUiActionContext,
  handlers: readonly ElizaGenUiActionHandler[],
): Promise<ElizaGenUiActionResult> {
  const eventName = action.event.name;
  // #12087 Item 26: the gate reads the boot-time registry (built-in prefixes +
  // any names/prefixes feature/plugin modules registered). Unregistered → throw.
  if (!isElizaGenUiActionAllowed(eventName)) {
    throw new ElizaGenUiActionError(
      `Generated UI action "${eventName}" is not allowed.`,
      action,
    );
  }
  const handler = handlers.find((candidate) => candidate.canHandle(eventName));
  if (!handler) {
    throw new ElizaGenUiActionError(
      `No generated UI action handler registered for "${eventName}".`,
      action,
    );
  }
  return handler.handle(action, context);
}
