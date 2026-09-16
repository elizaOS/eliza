/** Runs the adapter's HTTP streaming and teardown contracts in Node, outside Bun's native server path. */
import { test } from "bun:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("Node adapter preserves streaming, transport failures, and forced teardown", async () => {
  await promisify(execFile)(
    "node",
    [
      "--test",
      fileURLToPath(
        new URL("./fixtures/fetch-server-node.mjs", import.meta.url),
      ),
    ],
    { timeout: 10_000 },
  );
}, 15_000);
