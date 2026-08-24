/**
 * Verifies that the action barrel exposes the complete runtime surface of its
 * source modules without wrapping or replacing any exported value.
 */
import { describe, expect, it } from "vitest";
import * as connectAccount from "./connect-account.ts";
import * as contact from "./contact.ts";
import * as contextSignal from "./context-signal.ts";
import * as contextSignalLexicon from "./context-signal-lexicon.ts";
import * as database from "./database.ts";
import * as extractParams from "./extract-params.ts";
import * as groundedActionReply from "./grounded-action-reply.ts";
import * as actionIndex from "./index.ts";
import * as logs from "./logs.ts";
import * as memories from "./memories.ts";
import * as pageActionGroups from "./page-action-groups.ts";
import * as plugin from "./plugin.ts";
import * as recentConversationTexts from "./recent-conversation-texts.ts";
import * as runtime from "./runtime.ts";
import * as settingsActions from "./settings-actions.ts";
import * as terminal from "./terminal.ts";
import * as trigger from "./trigger.ts";

const directExports = {
  ...connectAccount,
  ...contact,
  ...contextSignal,
  ...contextSignalLexicon,
  ...database,
  ...extractParams,
  ...groundedActionReply,
  ...logs,
  ...memories,
  ...pageActionGroups,
  ...plugin,
  ...recentConversationTexts,
  ...runtime,
  ...settingsActions,
  ...terminal,
  ...trigger,
};

describe("actions index", () => {
  it("re-exports the complete runtime surface of every action module", () => {
    expect(Object.keys(actionIndex).sort()).toEqual(
      Object.keys(directExports).sort(),
    );
  });

  it("preserves the identity of every re-exported value", () => {
    for (const [name, value] of Object.entries(directExports)) {
      expect(Reflect.get(actionIndex, name), name).toBe(value);
    }
  });
});
