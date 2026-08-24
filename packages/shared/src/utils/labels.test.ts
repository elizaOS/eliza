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

  it("preserves all supported environment key acronyms", () => {
    expect(autoLabel("FOO_SSH_PRIVATE_KEY", "foo")).toBe("SSH Private Key");
    expect(autoLabel("FOO_SSL_CERT", "foo")).toBe("SSL Cert");
    expect(autoLabel("FOO_HTTP_PROXY", "foo")).toBe("HTTP Proxy");
    expect(autoLabel("FOO_HTTPS_PORT", "foo")).toBe("HTTPS Port");
    expect(autoLabel("FOO_RPC_NODE", "foo")).toBe("RPC Node");
    expect(autoLabel("FOO_NFT_METADATA", "foo")).toBe("NFT Metadata");
    expect(autoLabel("FOO_EVM_CHAIN_ID", "foo")).toBe("EVM Chain ID");
    expect(autoLabel("FOO_TLS_ENABLED", "foo")).toBe("TLS Enabled");
    expect(autoLabel("FOO_DNS_RESOLVER", "foo")).toBe("DNS Resolver");
    expect(autoLabel("FOO_IP_ADDRESS", "foo")).toBe("IP Address");
    expect(autoLabel("FOO_JWT_SECRET", "foo")).toBe("JWT Secret");
    expect(autoLabel("FOO_SDK_VERSION", "foo")).toBe("SDK Version");
    expect(autoLabel("FOO_LLM_MODEL", "foo")).toBe("LLM Model");
  });

  it("handles consecutive acronyms and compound names", () => {
    expect(autoLabel("FOO_JWT_SDK_TOKEN", "foo")).toBe("JWT SDK Token");
    expect(autoLabel("PLUGIN_TLS_DNS_SERVER", "plugin")).toBe(
      "TLS DNS Server",
    );
    expect(autoLabel("FOO_EVM_RPC_URL", "foo")).toBe("EVM RPC URL");
  });

  it("filters out empty segments from consecutive underscores", () => {
    expect(autoLabel("PLUGIN__API___KEY", "plugin")).toBe("API Key");
    expect(autoLabel("__FOO__BAR__", "other")).toBe("Foo Bar");
  });

  it("handles single-letter tokens and empty string inputs", () => {
    expect(autoLabel("PLUGIN_A_B_C", "plugin")).toBe("A B C");
    expect(autoLabel("", "plugin")).toBe("");
  });
});
