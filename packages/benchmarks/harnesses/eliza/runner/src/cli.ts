import { elizaLogger } from "@elizaos/core";
import { startBenchmarkServer } from "./server.js";
import { formatUnknownError } from "./server-utils.js";

startBenchmarkServer().catch((error: unknown) => {
  elizaLogger.error(
    `[bench] Failed to start benchmark server: ${formatUnknownError(error)}`,
  );
  process.exitCode = 1;
});
