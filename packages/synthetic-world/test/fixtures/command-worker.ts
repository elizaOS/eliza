/**
 * Runs one real subprocess against the local lease and command stores for
 * collision and uncatchable crash-checkpoint coverage.
 */

import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../../cloud/test-mocks/src/synthetic-environment";
import {
  SqliteSyntheticCommandJournal,
  SYNTHETIC_WORLD_COMMAND_VERSION,
} from "../../src";

const databasePath = process.env.SYNTHETIC_TEST_DATABASE_PATH;
const authorityJson = process.env.SYNTHETIC_TEST_AUTHORITY;
const commandId = process.env.SYNTHETIC_TEST_COMMAND_ID;
const crashAt = process.env.SYNTHETIC_TEST_CRASH_AT ?? "";
if (!databasePath || !authorityJson || !commandId) {
  throw new Error("Synthetic command worker environment is incomplete");
}

const authority = JSON.parse(
  authorityJson,
) as SyntheticEnvironmentLeaseAuthority;
const store = new SqliteSyntheticEnvironmentLeaseStore(databasePath);
const journal = new SqliteSyntheticCommandJournal(store);

try {
  const execution = await journal.execute(
    authority,
    {
      version: SYNTHETIC_WORLD_COMMAND_VERSION,
      namespace: authority.namespace,
      generation: authority.generation,
      commandId,
      type: "test.write",
      payload: { value: "once" },
    },
    (database) => {
      database.run(
        "CREATE TABLE IF NOT EXISTS synthetic_test_writes (command_id TEXT PRIMARY KEY)",
      );
      database.run(
        "INSERT INTO synthetic_test_writes (command_id) VALUES (?)",
        [commandId],
      );
      if (crashAt === "MUTATION") process.exit(86);
      return { written: commandId };
    },
    {
      onCheckpoint(checkpoint) {
        if (checkpoint.phase === crashAt) process.exit(86);
      },
    },
  );
  process.stdout.write(`${JSON.stringify({ replayed: execution.replayed })}\n`);
} catch (error) {
  // error-policy:J1 The subprocess protocol exposes a typed collision to its parent test.
  const errorCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "UNCLASSIFIED";
  process.stdout.write(`${JSON.stringify({ errorCode })}\n`);
} finally {
  store.close();
}
