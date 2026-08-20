/**
 * Deterministic tests for labels derived from plugin configuration keys.
 * Coverage locks prefix removal, title casing, and known-acronym preservation.
 */
import { describe, expect, it } from "vitest";
import { autoLabel } from "./labels";

describe("autoLabel", () => {
  it("strips the underscored plugin prefix and preserves acronyms", () => {
    expect(autoLabel("PLUGIN_API_KEY", "plugin")).toBe("API Key");
    expect(autoLabel("FOO_ID_LIST", "foo")).toBe("ID List");
  });

  it("strips the collapsed (hyphen-removed) plugin prefix", () => {
    // "my-plugin" → prefixes "MY_PLUGIN_" and "MYPLUGIN_"; the key uses the
    // collapsed form.
    expect(autoLabel("MYPLUGIN_URL_BASE", "my-plugin")).toBe("URL Base");
  });

  it("title-cases ordinary words", () => {
    expect(autoLabel("FOO_REGULAR_WORD", "foo")).toBe("Regular Word");
  });

  it("leaves a key without the plugin prefix as a single title-cased token", () => {
    expect(autoLabel("SOMEKEY", "other")).toBe("Somekey");
  });

  it("does not strip a prefix-only key (length must strictly exceed the prefix)", () => {
    expect(autoLabel("PLUGIN_", "plugin")).toBe("Plugin");
  });

  it("handles lowercase and mixed-case keys and plugin ids", () => {
    expect(autoLabel("plugin_api_key", "plugin")).toBe("API Key");
    expect(autoLabel("plugin_rpc_url", "plugin")).toBe("RPC URL");
    expect(autoLabel("custom_client_secret", "custom")).toBe("Client Secret");
  });
});
