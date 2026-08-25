/**
 * Recovers extension-to-page messaging after navigation or content-script
 * eviction without reinjecting into healthy pages and duplicating listeners.
 */
export async function sendWithContentScriptRecovery<T>(args: {
  send: () => Promise<T>;
  inject: () => Promise<void>;
}): Promise<T> {
  try {
    return await args.send();
  } catch {
    // error-policy:J1 Recover a missing content-script transport once, then surface retry failure.
    await args.inject();
    return await args.send();
  }
}

export function assertContentScriptPageUrl(
  expectedUrl: string,
  currentUrl: string,
): void {
  if (currentUrl !== expectedUrl) {
    throw new Error(
      "The page navigated after browser action authorization; refusing to use the new page.",
    );
  }
}
