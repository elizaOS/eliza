/** Bounded source shutdown; parser failures remain authoritative. */
export async function closeBackupIterator(
  iterator: AsyncIterator<Uint8Array>,
  graceMs = 250,
): Promise<void> {
  let close: Promise<unknown>;
  try {
    close = Promise.resolve(iterator.return?.());
  } catch (_closeFailure: unknown) {
    // error-policy:J5 parser failure/cancellation is authoritative; a source
    // iterator may already have torn itself down synchronously.
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
  });
  try {
    await Promise.race([
      close.then(
        () => undefined,
        (_closeFailure: unknown) => undefined,
      ),
      bounded,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
