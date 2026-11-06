import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// Real loopback HTTP, on-disk ownership restart and owned subprocess lifecycle.
// Product view metadata belongs to the consuming host's contract tests.
test("native host transport and process lifecycle", () => {
  execFileSync(
    "node",
    [
      "--test",
      fileURLToPath(
        new URL("../native-host/gateway.e2e.test.mjs", import.meta.url),
      ),
      fileURLToPath(
        new URL("../native-host/surface-channel.test.mjs", import.meta.url),
      ),
      fileURLToPath(
        new URL("../native-host/surface-client.test.mjs", import.meta.url),
      ),
    ],
    { timeout: 30000, stdio: "pipe" },
  );
});
