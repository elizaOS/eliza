import { startEliza } from "../../src/runtime/eliza.ts";

startEliza().catch((error) => {
  console.error(
    "[streaming-live] Fatal API startup error:",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});
