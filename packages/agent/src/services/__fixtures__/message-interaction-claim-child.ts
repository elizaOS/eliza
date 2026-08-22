/** Executes one file-store claim in a separate process for lock/CAS tests. */

import fs from "node:fs/promises";
import { FileMessageInteractionSessionStore } from "../message-interaction-session-store.ts";

const [stateDirectory, contextPath] = process.argv.slice(2);
if (!stateDirectory || !contextPath)
  throw new Error("state directory and context path are required");
const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
const store = new FileMessageInteractionSessionStore({ stateDirectory });
const result = await store.claimIfCurrent(context);
process.stdout.write(result.status);
