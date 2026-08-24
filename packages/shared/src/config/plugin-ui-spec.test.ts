/**
 * Unit tests for plugin UI specification generators.
 */

import { describe, expect, it } from "vitest";
import {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
  type PluginForUiSpec,
  type PluginUiSpec,
} from "./plugin-ui-spec.js";

function getProps(spec: PluginUiSpec, id: string): Record<string, unknown> {
  return (spec.elements[id]?.props as Record<string, unknown>) ?? {};
}

describe("buildPluginConfigUiSpec", () => {
  it("builds a basic UI spec for a disabled plugin without parameters", () => {
    const plugin: PluginForUiSpec = {
      id: "plugin-test",
      name: "Test Plugin",
      description: "A test plugin description",
      enabled: false,
      parameters: [],
    };

    const spec = buildPluginConfigUiSpec(plugin);

    expect(spec.version).toBe(1);
    expect(spec.root).toBe("root");
    expect(spec.state).toEqual({ pluginId: "plugin-test" });

    expect(getProps(spec, "title")).toEqual({
      level: 3,
      text: "Configure Test Plugin",
    });
    expect(getProps(spec, "desc")).toEqual({
      text: "A test plugin description",
      className: "text-xs text-muted",
    });
    expect(getProps(spec, "status")).toEqual({
      text: "Disabled",
      variant: "outline",
    });

    // Enabled button should be present when enabled is false
    expect(spec.elements.enableBtn).toBeDefined();
    expect(getProps(spec, "actions").children).toEqual([
      "saveBtn",
      "enableBtn",
    ]);
  });

  it("handles status variants for enabled plugins based on required parameter completion", () => {
    const readyPlugin: PluginForUiSpec = {
      id: "ready-plugin",
      name: "Ready Plugin",
      enabled: true,
      parameters: [
        { key: "API_KEY", required: true, isSet: true },
        { key: "OPTIONAL_SETTING", required: false, isSet: false },
      ],
    };

    const readySpec = buildPluginConfigUiSpec(readyPlugin);
    expect(getProps(readySpec, "status")).toEqual({
      text: "Ready",
      variant: "default",
    });
    // Enable button should not be included when enabled is true
    expect(getProps(readySpec, "actions").children).toEqual(["saveBtn"]);

    const unconfiguredPlugin: PluginForUiSpec = {
      id: "unconfigured-plugin",
      name: "Unconfigured Plugin",
      enabled: true,
      parameters: [{ key: "API_KEY", required: true, isSet: false }],
    };

    const unconfiguredSpec = buildPluginConfigUiSpec(unconfiguredPlugin);
    expect(getProps(unconfiguredSpec, "status")).toEqual({
      text: "Needs Configuration",
      variant: "secondary",
    });
  });

  it("creates password and text input fields, validation rules, and hints", () => {
    const plugin: PluginForUiSpec = {
      id: "complex-plugin",
      name: "Complex Plugin",
      enabled: true,
      parameters: [
        {
          key: "AUTH_TOKEN",
          required: true,
          isSet: true,
          label: "Secret Token",
          description: "Your secret access token",
        },
        {
          key: "BASE_URL",
          required: false,
          isSet: false,
          label: "API Base URL",
        },
      ],
    };

    const spec = buildPluginConfigUiSpec(plugin);

    expect(spec.state).toEqual({
      pluginId: "complex-plugin",
      "config.AUTH_TOKEN": "",
      "config.BASE_URL": "",
    });

    const tokenField = spec.elements.field_AUTH_TOKEN;
    const tokenProps = getProps(spec, "field_AUTH_TOKEN");
    expect(tokenProps.type).toBe("password");
    expect(tokenProps.placeholder).toBe("••••••• (already set)");
    expect(tokenProps.label).toBe("Secret Token");
    expect(tokenField.validation).toEqual({
      checks: [{ rule: "required", message: "AUTH_TOKEN is required" }],
    });

    const hint = spec.elements.hint_AUTH_TOKEN;
    expect(hint).toBeDefined();
    expect(getProps(spec, "hint_AUTH_TOKEN").text).toBe(
      "Your secret access token",
    );

    const urlField = spec.elements.field_BASE_URL;
    const urlProps = getProps(spec, "field_BASE_URL");
    expect(urlProps.type).toBe("text");
    expect(urlProps.placeholder).toBe("Optional");
    expect(urlProps.label).toBe("API Base URL");
    expect(urlField.validation).toBeUndefined();
  });

  it("adds testBtn for connector category plugins", () => {
    const connector: PluginForUiSpec = {
      id: "slack-connector",
      name: "Slack",
      category: "connector",
      enabled: true,
      parameters: [],
    };

    const spec = buildPluginConfigUiSpec(connector);
    expect(spec.elements.testBtn).toBeDefined();
    expect(getProps(spec, "actions").children).toEqual(["saveBtn", "testBtn"]);
  });
});

describe("buildPluginListUiSpec", () => {
  it("generates a compact plugin list UI spec", () => {
    const plugins: PluginForUiSpec[] = [
      {
        id: "plugin-a",
        name: "Plugin Alpha",
        description: "First plugin",
        enabled: true,
        parameters: [],
      },
      {
        id: "plugin-b",
        name: "Plugin Beta",
        enabled: false,
        parameters: [],
      },
    ];

    const spec = buildPluginListUiSpec(plugins, "Available Extensions");

    expect(spec.version).toBe(1);
    expect(spec.root).toBe("root");
    expect(getProps(spec, "heading")).toEqual({
      level: 3,
      text: "Available Extensions",
    });

    expect(spec.elements.card_0).toBeDefined();
    expect(getProps(spec, "name_0").text).toBe("Plugin Alpha");
    expect(getProps(spec, "desc_0").text).toBe("First plugin");
    expect(getProps(spec, "badge_0")).toEqual({
      text: "Enabled",
      variant: "default",
    });

    expect(spec.elements.card_1).toBeDefined();
    expect(getProps(spec, "name_1").text).toBe("Plugin Beta");
    expect(getProps(spec, "desc_1").text).toBe("No description");
    expect(getProps(spec, "badge_1")).toEqual({
      text: "Available",
      variant: "outline",
    });
  });

  it("handles empty plugin list", () => {
    const spec = buildPluginListUiSpec([], "Empty List");
    expect(getProps(spec, "list").children).toEqual([]);
  });
});
