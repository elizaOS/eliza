import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Retain downloads and elevation scripts until the writer has settled. */
export async function withTemporaryImageDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "elizaos-usb-installer-"));
  let result: T;
  try {
    result = await operation(directory);
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "USB image operation and temporary directory cleanup both failed.",
      );
    }
    throw error;
  }
  await rm(directory, { recursive: true, force: true });
  return result;
}
