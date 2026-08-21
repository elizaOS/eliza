/** Registers the Linear service and discoverable read-only Linear action family. */

import type { Plugin } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { linearAction } from "./action.js";
import { LinearService } from "./service.js";

const promotedLinearActions = promoteSubactionsToActions(linearAction);
for (const action of promotedLinearActions) {
  if (action.name !== "LINEAR") {
    action.tags = ["domain:work", "capability:read"];
  }
}

export const linearPlugin: Plugin = {
  name: "linear",
  description:
    "Read-only Linear work tracking: assigned issues, workspace issue search, issue detail, and teams.",
  services: [LinearService],
  actions: [...promotedLinearActions],
};

export default linearPlugin;
