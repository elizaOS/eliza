/** The plugin deny list reaches the assistant plugins the host builds in. */
import { describe, expect, it } from "vitest";
import { createAssistantPlugins } from "../src/runtime/assistant-plugins.ts";
import { collectConfiguredDeniedPluginNames } from "../src/runtime/plugin-collector.ts";

const character = { name: "Eliza", bio: [] };
const names = (deny: string[], env: NodeJS.ProcessEnv = {}) =>
  createAssistantPlugins(
    character,
    collectConfiguredDeniedPluginNames({ plugins: { deny } }, env),
  ).map((plugin) => plugin.name);

describe("createAssistantPlugins deny", () => {
  it("drops each member the deny list or ELIZA_SKIP_PLUGINS names", () => {
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

  it.each(["@elizaos/plugin-assistant", "assistant"])(
    "refuses to boot when %j denies the member that installs the message service",
    (denied) => {
      expect(() => names([denied])).toThrow(
        expect.objectContaining({ code: "PLUGIN_DENY_UNENFORCEABLE" }),
      );
    },
  );
});
