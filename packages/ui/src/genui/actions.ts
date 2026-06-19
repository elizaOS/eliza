import { isElizaGenUiActionNameAllowed } from "./catalog";
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
  if (!isElizaGenUiActionNameAllowed(eventName)) {
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
