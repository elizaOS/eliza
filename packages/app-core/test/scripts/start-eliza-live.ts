/**
 * Boots the real app-core runtime (startEliza) as a child process for live
 * streaming tests; exits non-zero on startup failure.
 */
import { startEliza } from "../../src/runtime/eliza.ts";

startEliza().catch((error) => {
  console.error(
    "[streaming-live] Fatal API startup error:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
