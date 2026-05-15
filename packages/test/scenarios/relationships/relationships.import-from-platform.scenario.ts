/**
 * Import contacts from a platform: user asks to import top Discord DM
 * partners into the Rolodex. The current relationship workflow falls
 * back to listing the existing Rolodex instead of importing from a
 * platform.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "relationships.import-from-platform",
  title: "Platform import request falls back to Rolodex listing",
  domain: "relationships",
  tags: ["lifeops", "relationships", "cross-platform", "routing"],
  description:
    "A request to import Discord DM partners currently routes to the existing Rolodex list flow instead of an import action.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: import from platform",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "import-discord-contacts",
      room: "main",
      text: "Import my top 20 Discord DM partners into my Rolodex.",
      responseIncludesAny: ["Rolodex", "contacts"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "import-request-routing",
      predicate: async (ctx) => {
        const action = ctx.actionsCalled.find(
          (entry) => entry.actionName === "RELATIONSHIP",
        );
        const data =
          action?.result?.data && typeof action.result.data === "object"
            ? (action.result.data as {
                subaction?: string;
                contacts?: unknown[];
              })
            : null;
        if (!data) {
          return "expected RELATIONSHIP result data";
        }
        if (data.subaction !== "list_contacts") {
          return `expected list_contacts fallback, got ${data.subaction ?? "(missing)"}`;
        }
        if (!Array.isArray(data.contacts)) {
          return "expected contacts array in Rolodex list result";
        }
        return undefined;
      },
    },
  ],
});
