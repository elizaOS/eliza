/** Retrieval evidence stays task-scoped without changing the accessible catalog or original dialogue. */
import { describe, expect, it } from "vitest";
import { buildActionCatalog } from "./action-catalog";
import { retrieveActions } from "./action-retrieval";

const catalog = buildActionCatalog([
  {
    name: "WRITE",
    description: "Create and write an HTML file",
    contexts: ["documents"],
  },
  { name: "READ", description: "Read a file", contexts: ["documents"] },
  {
    name: "CALENDAR",
    description: "Find calendar meetings",
    contexts: ["calendar"],
  },
]);
const history =
  "Find the launch meeting in my calendar. Original source and correction: Thursday, not Tuesday.";

describe("task-scoped action retrieval", () => {
  it.each([
    "Create a small HTML page and test it in the browser.",
    "Use the terminal to create a page, then read it back.",
    "Create a counter. Show it in the browser.",
    "Create an HTML page and also verify its button.",
    "Write an HTML file that works on mobile too.",
  ])(
    "does not import unrelated history for a self-contained task: %s",
    (messageText) => {
      const result = retrieveActions({
        catalog,
        messageText,
        recentConversationText: history,
      });
      expect(result.query.text).toBe(messageText);
      expect(result.results.map((action) => action.name).sort()).toEqual([
        "CALENDAR",
        "READ",
        "WRITE",
      ]);
    },
  );

  it.each([
    "Please fix it.",
    "Can you open that meeting?",
    "Could you please fix it?",
    "Also show me that meeting.",
    "Continue the work.",
    "Retry the previous task.",
    "Use the same one, with the earlier correction.",
    "Read the previous message and check the calendar.",
    "Change its time to Friday.",
    "Keep going.",
    "Open the last one.",
    "Make another one.",
    "Again.",
  ])(
    "preserves original evidence for prior-work references: %s",
    (messageText) => {
      const result = retrieveActions({
        catalog,
        messageText,
        recentConversationText: history,
      });
      expect(result.query.text).toContain(history);
      expect(result.query.text).toContain(messageText);
    },
  );

  it("ranks using current outcomes while preserving exact hints and the complete catalog", () => {
    const result = retrieveActions({
      catalog,
      messageText: "Create a small HTML page and test it.",
      intents: ["write an HTML file", "read the file to verify its contents"],
      recentConversationText: history,
      parentActionHints: ["CALENDAR"],
    });
    expect(result.query.text).toContain(
      "write an HTML file\nread the file to verify its contents",
    );
    expect(result.query.text).not.toContain(history);
    expect(result.results[0]?.name).toBe("CALENDAR");
    expect(result.results).toHaveLength(3);
  });
});
