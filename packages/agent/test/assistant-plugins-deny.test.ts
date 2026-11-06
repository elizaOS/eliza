/**
 * The host's plugin deny list reaches the assistant plugins it builds in, and
 * the chat-authority settings are validated before a runtime exists.
 */
import { describe, expect, it } from "vitest";
import { createAssistantPlugins } from "../src/runtime/assistant-plugins.ts";

const character = { name: "Eliza", bio: [] };
const names = (deny: string[], env: NodeJS.ProcessEnv = {}) =>
  createAssistantPlugins(character, { plugins: { deny } }, env).map(
    (plugin) => plugin.name,
  );

describe("createAssistantPlugins", () => {
  it("drops each member plugins.deny or ELIZA_SKIP_PLUGINS names", () => {
    const all = names([]);
    expect(all).toEqual(
      expect.arrayContaining([
        "assistant",
        "documents",
        "trajectories",
        "relationships-services",
        "credentials-setup",
      ]),
    );

    const kept = names(["documents", "trajectories"], {
      ELIZA_SKIP_PLUGINS: "credentials-setup",
    });
    expect(kept).toEqual(
      all.filter(
        (name) =>
          !["documents", "trajectories", "credentials-setup"].includes(name),
      ),
    );
  });

  it.each([
    [["@elizaos/plugin-assistant"], {}],
    [["assistant"], {}],
    [[], { ELIZA_SKIP_PLUGINS: "@elizaos/plugin-assistant" }],
  ])(
    "refuses to boot when %j %j denies the member that installs the message service",
    (deny, env) => {
      expect(() => names(deny, env)).toThrow(
        expect.objectContaining({ code: "PLUGIN_DENY_UNENFORCEABLE" }),
      );
    },
  );

  it.each([
    [
      { ELIZA_CONVERSATION_CALLER_ROLE: "user" },
      "INVALID_CONVERSATION_CALLER_ROLE",
    ],
    [{ ELIZA_ACTION_ALLOWLIST: "" }, "INVALID_ACTION_ALLOWLIST"],
    [{ ELIZA_ACTION_ALLOWLIST: "[REPLY" }, "INVALID_ACTION_ALLOWLIST"],
  ])("refuses to boot on the malformed setting %j", (env, code) => {
    expect(() => names([], env)).toThrow(expect.objectContaining({ code }));
  });

  it("boots with valid chat-authority settings", () => {
    expect(
      names([], {
        ELIZA_CONVERSATION_CALLER_ROLE: "USER",
        ELIZA_ACTION_ALLOWLIST: JSON.stringify(["REPLY"]),
      }),
    ).toContain("assistant");
  });
});
