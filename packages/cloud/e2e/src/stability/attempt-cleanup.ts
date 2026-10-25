import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  openSync,
  writeFileSync,
} from "node:fs";

/** Writes redacted evidence without following links or blocking on special files. */
export function writeParentOwnedStabilityLog(
  filePath: string,
  content: string,
): void {
  const descriptor = openSync(
    filePath,
    constants.O_CREAT |
      constants.O_WRONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const identity = fstatSync(descriptor);
    if (
      !identity.isFile() ||
      identity.uid !== process.getuid?.() ||
      identity.nlink !== 1
    ) {
      throw new Error(
        "scenario log must be a parent-owned regular file with one link",
      );
    }
    fchmodSync(descriptor, 0o600);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Completes every owned teardown step before reporting collected failures. */
export async function runStabilityCleanup(
  steps: readonly (() => void | Promise<void>)[],
  priorFailures: readonly unknown[] = [],
): Promise<void> {
  const failures = [...priorFailures];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      // error-policy:J7 A failed evidence or cleanup step must not skip other owned teardown.
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Cloud stability attempt cleanup failed",
    );
  }
}
