/**
 * Child process for the local backup crash-recovery e2e: boots a real PGlite
 * runtime over the parent's state directory and restores a streamed backup
 * while `ELIZA_CRASH_INJECT` hard-exits the process at a restore swap point.
 */
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { restoreLocalAgentBackup } from "../../src/services/agent-backup.ts";

const stateDir = process.env.ELIZA_STATE_DIR;
const characterName = process.env.BACKUP_CRASH_CHARACTER;
const fileName = process.env.BACKUP_CRASH_FILE;
if (!stateDir || !characterName || !fileName)
  throw new Error("crash child requires state dir, character and backup file");
const fixture = await createTestRuntime({
  characterName,
  pgliteDir: path.join(stateDir, ".elizadb"),
  settings: { LOAD_DOCS_ON_STARTUP: false },
});
await restoreLocalAgentBackup(fixture.runtime, fileName);
// Reaching here means the armed fault never fired.
process.stdout.write("BACKUP_CRASH_CHILD_COMPLETED\n");
process.exit(0);
