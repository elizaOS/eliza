/**
 * Unit tests for plugin UI specification generators.
 */

import { describe, expect, it } from "vitest";
import {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
  type PluginForUiSpec,
} from "./plugin-ui-spec.js";

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

    expect(spec.elements.title.props).toEqual({
      level: 3,
      text: "Configure Test Plugin",
    });
    expect(spec.elements.desc.props).toEqual({
      text: "A test plugin description",
      className: "text-xs text-muted",
    });
    expect(spec.elements.status.props).toEqual({
      text: "Disabled",
      variant: "outline",
    });

    // Enabled button should be present when enabled is false
    expect(spec.elements.enableBtn).toBeDefined();
    expect(spec.elements.actions.props.children).toEqual([
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
    expect(readySpec.elements.status.props).toEqual({
      text: "Ready",
      variant: "default",
    });
    // Enable button should not be included when enabled is true
    expect(readySpec.elements.actions.props.children).toEqual(["saveBtn"]);

    const unconfiguredPlugin: PluginForUiSpec = {
      id: "unconfigured-plugin",
      name: "Unconfigured Plugin",
      enabled: true,
      parameters: [{ key: "API_KEY", required: true, isSet: false }],
    };

    const unconfiguredSpec = buildPluginConfigUiSpec(unconfiguredPlugin);
    expect(unconfiguredSpec.elements.status.props).toEqual({
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
    expect(tokenField.props.type).toBe("password");
    expect(tokenField.props.placeholder).toBe("••••••• (already set)");
    expect(tokenField.props.label).toBe("Secret Token");
    expect(tokenField.validation).toEqual({
      checks: [{ rule: "required", message: "AUTH_TOKEN is required" }],
    });

    const hint = spec.elements.hint_AUTH_TOKEN;
    expect(hint).toBeDefined();
    expect(hint.props.text).toBe("Your secret access token");

    const urlField = spec.elements.field_BASE_URL;
    expect(urlField.props.type).toBe("text");
    expect(urlField.props.placeholder).toBe("Optional");
    expect(urlField.props.label).toBe("API Base URL");
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
    expect(spec.elements.actions.props.children).toEqual([
      "saveBtn",
      "testBtn",
    ]);
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
    expect(spec.elements.heading.props).toEqual({
      level: 3,
      text: "Available Extensions",
    });

    expect(spec.elements.card_0).toBeDefined();
    expect(spec.elements.name_0.props.text).toBe("Plugin Alpha");
    expect(spec.elements.desc_0.props.text).toBe("First plugin");
    expect(spec.elements.badge_0.props).toEqual({
      text: "Enabled",
      variant: "default",
    });

    expect(spec.elements.card_1).toBeDefined();
    expect(spec.elements.name_1.props.text).toBe("Plugin Beta");
    expect(spec.elements.desc_1.props.text).toBe("No description");
    expect(spec.elements.badge_1.props).toEqual({
      text: "Available",
      variant: "outline",
    });
  });

  it("handles empty plugin list", () => {
    const spec = buildPluginListUiSpec([], "Empty List");
    expect(spec.elements.list.props.children).toEqual([]);
  });
});
