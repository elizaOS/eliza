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
    expect(autoLabel("plugin_db_uri", "plugin")).toBe("DB URI");
    expect(autoLabel("plugin_sql_host", "plugin")).toBe("SQL Host");
    expect(autoLabel("plugin_ai_model", "plugin")).toBe("AI Model");
    expect(autoLabel("plugin_cli_path", "plugin")).toBe("CLI Path");
    expect(autoLabel("custom_client_secret", "custom")).toBe("Client Secret");
  });

  it("preserves all newly added ecosystem acronyms across key positions", () => {
    const acronymCases: Array<[string, string]> = [
      ["plugin_ai_model", "AI Model"],
      ["plugin_cli_path", "CLI Path"],
      ["plugin_cpu_limit", "CPU Limit"],
      ["plugin_db_uri", "DB URI"],
      ["plugin_gpu_device", "GPU Device"],
      ["plugin_os_version", "OS Version"],
      ["plugin_otp_secret", "OTP Secret"],
      ["plugin_sql_host", "SQL Host"],
      ["plugin_ui_theme", "UI Theme"],
      ["plugin_uri_endpoint", "URI Endpoint"],
      ["plugin_ws_port", "WS Port"],
      ["plugin_wss_url", "WSS URL"],
    ];

    for (const [key, expected] of acronymCases) {
      expect(autoLabel(key, "plugin")).toBe(expected);
    }
  });
});
