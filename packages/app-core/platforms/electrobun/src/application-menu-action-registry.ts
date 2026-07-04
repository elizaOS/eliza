/** Implements Electrobun desktop application menu action registry ts behavior for app-core shell integration. */
type ApplicationMenuActionHandler = (
  action: string | undefined,
) => Promise<void>;

let handler: ApplicationMenuActionHandler | null = null;

export function setApplicationMenuActionHandler(
  nextHandler: ApplicationMenuActionHandler | null,
): void {
  handler = nextHandler;
}

export async function invokeApplicationMenuAction(
  action: string | undefined,
): Promise<boolean> {
  if (!handler) {
    return false;
  }
  await handler(action);
  return true;
}
