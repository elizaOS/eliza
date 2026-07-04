/**
 * `autoLabel` derives the human-readable label shown next to a plugin config
 * field from its env-key + plugin id — strip the plugin prefix, title-case the
 * remaining words, but preserve known acronyms (API/URL/ID/…). Untested, so a
 * regression in prefix stripping or the acronym set would silently mangle every
 * generated settings label. Pure.
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
});
