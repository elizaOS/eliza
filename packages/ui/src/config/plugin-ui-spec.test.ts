/**
 * Unit coverage for the plugin-config UI-spec surface re-exported from this
 * module (`buildPluginConfigUiSpec` / `buildPluginListUiSpec`). Drives the real
 * exported builders and pins the branches the settings-form renderer relies
 * on: missing descriptions, label fallbacks, required/optional placeholders,
 * secret-key input masking, status derivation, action wiring, and list
 * ordering including the empty case.
 */
import { describe, expect, it } from "vitest";

import {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
  type PluginUiSpec,
} from "./plugin-ui-spec";

function getProps(spec: PluginUiSpec, id: string): Record<string, unknown> {
  return (spec.elements[id]?.props as Record<string, unknown>) ?? {};
}

describe("buildPluginConfigUiSpec", () => {
  it("omits the description element when the plugin has none", () => {
    const spec = buildPluginConfigUiSpec({
      id: "no-desc",
      name: "Bare Plugin",
      enabled: true,
      parameters: [],
    });

    expect(spec.elements.desc).toBeUndefined();
    expect(getProps(spec, "title")).toEqual({
      level: 3,
      text: "Configure Bare Plugin",
    });
    expect(getProps(spec, "root").children).toEqual([
      "header",
      "status",
      "sep",
      "fields",
      "actions",
    ]);
  });

  it("falls back to the parameter key as label and flags unset required fields", () => {
    const spec = buildPluginConfigUiSpec({
      id: "label-fallback",
      name: "Label Fallback",
      enabled: true,
      parameters: [{ key: "MODEL_NAME", required: true }],
    });

    expect(getProps(spec, "field_MODEL_NAME")).toMatchObject({
      label: "MODEL_NAME",
      placeholder: "Required",
      statePath: "config.MODEL_NAME",
      type: "text",
    });
    expect(spec.elements.field_MODEL_NAME.validation).toEqual({
      checks: [{ rule: "required", message: "MODEL_NAME is required" }],
    });
    expect(spec.state).toEqual({
      pluginId: "label-fallback",
      "config.MODEL_NAME": "",
    });
    expect(getProps(spec, "fields").children).toEqual(["field_MODEL_NAME"]);
  });

  it("masks inputs for KEY, SECRET and PASSWORD keys while keeping plain keys textual", () => {
    const spec = buildPluginConfigUiSpec({
      id: "secrets",
      name: "Secrets",
      enabled: true,
      parameters: [
        { key: "WALLET_PRIVATE_KEY" },
        { key: "AUTH_SECRET" },
        { key: "DB_PASSWORD" },
        { key: "RETRY_LIMIT" },
      ],
    });

    expect(getProps(spec, "field_WALLET_PRIVATE_KEY").type).toBe("password");
    expect(getProps(spec, "field_AUTH_SECRET").type).toBe("password");
    expect(getProps(spec, "field_DB_PASSWORD").type).toBe("password");
    expect(getProps(spec, "field_RETRY_LIMIT").type).toBe("text");
  });

  it("reports Ready for an enabled plugin with no required parameters", () => {
    const spec = buildPluginConfigUiSpec({
      id: "ready-empty",
      name: "Ready Empty",
      enabled: true,
      parameters: [{ key: "OPTIONAL_FLAG" }],
    });

    expect(getProps(spec, "status")).toEqual({
      text: "Ready",
      variant: "default",
    });
    expect(spec.elements.enableBtn).toBeUndefined();
    expect(getProps(spec, "actions").children).toEqual(["saveBtn"]);
  });

  it("keeps the Disabled status even when every required parameter is set", () => {
    const spec = buildPluginConfigUiSpec({
      id: "disabled-but-set",
      name: "Disabled But Set",
      enabled: false,
      parameters: [{ key: "ENDPOINT", required: true, isSet: true }],
    });

    expect(getProps(spec, "status")).toEqual({
      text: "Disabled",
      variant: "outline",
    });
    expect(getProps(spec, "field_ENDPOINT").placeholder).toBe(
      "\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (already set)",
    );
    expect(getProps(spec, "actions").children).toEqual([
      "saveBtn",
      "enableBtn",
    ]);
  });

  it("wires the save action to the owning plugin id", () => {
    const spec = buildPluginConfigUiSpec({
      id: "wire-check",
      name: "Wire Check",
      enabled: true,
      parameters: [],
    });

    expect(getProps(spec, "saveBtn").on).toEqual({
      press: { action: "plugin:save", params: { pluginId: "wire-check" } },
    });
  });

  it("adds a connector-only test button wired to plugin:test", () => {
    const spec = buildPluginConfigUiSpec({
      id: "conn",
      name: "Connector",
      category: "connector",
      enabled: true,
      parameters: [],
    });

    expect(getProps(spec, "testBtn").on).toEqual({
      press: { action: "plugin:test", params: { pluginId: "conn" } },
    });
    expect(getProps(spec, "actions").children).toEqual(["saveBtn", "testBtn"]);
  });

  it("appends each hint directly after its own field and seeds config state", () => {
    const spec = buildPluginConfigUiSpec({
      id: "hints",
      name: "Hints",
      enabled: true,
      parameters: [
        { key: "ALPHA", description: "help for alpha" },
        { key: "BETA" },
      ],
    });

    expect(getProps(spec, "fields").children).toEqual([
      "field_ALPHA",
      "hint_ALPHA",
      "field_BETA",
    ]);
    expect(getProps(spec, "hint_ALPHA").text).toBe("help for alpha");
    expect(spec.state).toEqual({
      pluginId: "hints",
      "config.ALPHA": "",
      "config.BETA": "",
    });
  });
});

describe("buildPluginListUiSpec", () => {
  it("renders a single entry with index-addressed ids and configure wiring", () => {
    const spec = buildPluginListUiSpec(
      [
        {
          id: "solo",
          name: "Solo Plugin",
          description: "the only one",
          enabled: true,
          parameters: [],
        },
      ],
      "Single",
    );

    expect(spec.version).toBe(1);
    expect(spec.root).toBe("root");
    expect(spec.state).toEqual({});
    expect(getProps(spec, "root").children).toEqual(["heading", "list"]);
    expect(getProps(spec, "list").children).toEqual(["card_0"]);
    expect(getProps(spec, "card_0").children).toEqual([
      "name_0",
      "desc_0",
      "badge_0",
      "cfgBtn_0",
    ]);
    expect(getProps(spec, "badge_0")).toEqual({
      text: "Enabled",
      variant: "default",
    });
    expect(getProps(spec, "cfgBtn_0").on).toEqual({
      press: { action: "plugin:configure", params: { pluginId: "solo" } },
    });
  });

  it("maps multiple plugins to cards strictly by input order", () => {
    const spec = buildPluginListUiSpec(
      [
        { id: "later", name: "Registered Later", parameters: [] },
        { id: "earlier", name: "Registered Earlier", parameters: [] },
      ],
      "Order",
    );

    expect(getProps(spec, "list").children).toEqual(["card_0", "card_1"]);
    expect(getProps(spec, "name_0").text).toBe("Registered Later");
    expect(getProps(spec, "name_1").text).toBe("Registered Earlier");
    expect(getProps(spec, "desc_1").text).toBe("No description");
    expect(getProps(spec, "badge_1")).toEqual({
      text: "Available",
      variant: "outline",
    });
  });

  it("handles an empty plugin list with an empty stack under the heading", () => {
    const spec = buildPluginListUiSpec([], "Nothing Here");

    expect(getProps(spec, "heading")).toEqual({
      level: 3,
      text: "Nothing Here",
    });
    expect(getProps(spec, "list").children).toEqual([]);
    expect(Object.keys(spec.elements)).toEqual(["heading", "list", "root"]);
  });
});
