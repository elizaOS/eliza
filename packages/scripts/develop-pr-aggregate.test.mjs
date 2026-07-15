/**
 * Bun coverage entrypoint for the deterministic develop PR aggregate contract.
 * The same assertions run directly under Node in the bootstrap integrity lane;
 * this wrapper lets the changed-file gate measure the implementation they load.
 */
import { test } from "bun:test";

test("develop PR aggregate contract", async () => {
  await import("./develop-pr-aggregate.self-test.mjs");
});
