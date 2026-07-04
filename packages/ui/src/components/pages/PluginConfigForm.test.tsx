// @vitest-environment jsdom

// Renders the real PluginConfigForm to cover the modeToggle `configUiHint`:
// the backing field is hidden while the hidden-mode value is active and its
// last non-hidden value is restored when the mode toggles back. jsdom; state
// barrel stubbed.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo, PluginParamDef } from "../../api";
import { PluginConfigForm } from "./PluginConfigForm";

const stateMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(stateMock.value),
}));

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function makeParam(
  key: string,
  overrides: Partial<PluginParamDef> = {},
): PluginParamDef {
  return {
    key,
    type: "string",
    description: `${key} config`,
    required: false,
    sensitive: false,
    currentValue: null,
    isSet: false,
    ...overrides,
  };
}

function makePlugin(
  overrides: Partial<PluginInfo> & { id: string; key: string },
): PluginInfo {
  const { id, key, ...pluginOverrides } = overrides;
  return {
    id,
    name: id,
    description: `${id} plugin`,
    enabled: true,
    isActive: true,
    configured: false,
    envKey: null,
    category: "connector",
    source: "bundled",
    parameters: [
      makeParam(key, {
        currentValue: overrides.parameters?.[0]?.currentValue ?? null,
        isSet: overrides.parameters?.[0]?.isSet ?? false,
      }),
    ],
    configUiHints: {
      [key]: {
        modeToggle: {
          kind: "mode-toggle-with-hidden-field",
          enabledLabel: "Allow all chats",
          disabledLabel: "Allow only specific chats",
          enabledHelp: "Bot will respond in any chat",
          disabledHelp: "Bot will only respond in listed chat IDs",
          hiddenValue: "",
          restoreValue: "[]",
        },
      },
    },
    validationErrors: [],
    validationWarnings: [],
    ...pluginOverrides,
  } as PluginInfo;
}

function configField(pluginId: string, key: string): HTMLElement | null {
  return document.getElementById(`field-${pluginId}-${key}`);
}

beforeEach(() => {
  stateMock.value = { t };
});

afterEach(() => {
  cleanup();
});

describe("PluginConfigForm modeToggle configUiHint", () => {
  it("hides the backing field when the hidden-mode value is active", () => {
    const onParamChange = vi.fn();
    const plugin = makePlugin({
      id: "telegram",
      key: "TELEGRAM_ALLOWED_CHATS",
    });

    render(
      <PluginConfigForm
        plugin={plugin}
        pluginConfigs={{}}
        onParamChange={onParamChange}
      />,
    );

    expect(screen.getByText("Allow all chats")).toBeTruthy();
    expect(configField("telegram", "TELEGRAM_ALLOWED_CHATS")).toBeNull();

    fireEvent.click(screen.getByRole("switch"));

    expect(onParamChange).toHaveBeenCalledWith(
      "telegram",
      "TELEGRAM_ALLOWED_CHATS",
      "[]",
    );
    expect(screen.getByText("Allow only specific chats")).toBeTruthy();
    expect(configField("telegram", "TELEGRAM_ALLOWED_CHATS")).not.toBeNull();
  });

  it("restores the last non-hidden value for any plugin declaring the hint", () => {
    const onParamChange = vi.fn();
    const plugin = makePlugin({
      id: "matrix",
      key: "MATRIX_ALLOWED_ROOMS",
    });

    render(
      <PluginConfigForm
        plugin={plugin}
        pluginConfigs={{
          matrix: { MATRIX_ALLOWED_ROOMS: '["!room:example.org"]' },
        }}
        onParamChange={onParamChange}
      />,
    );

    expect(screen.getByText("Allow only specific chats")).toBeTruthy();
    expect(configField("matrix", "MATRIX_ALLOWED_ROOMS")).not.toBeNull();

    fireEvent.click(screen.getByRole("switch"));
    expect(onParamChange).toHaveBeenLastCalledWith(
      "matrix",
      "MATRIX_ALLOWED_ROOMS",
      "",
    );
    expect(configField("matrix", "MATRIX_ALLOWED_ROOMS")).toBeNull();

    fireEvent.click(screen.getByRole("switch"));
    expect(onParamChange).toHaveBeenLastCalledWith(
      "matrix",
      "MATRIX_ALLOWED_ROOMS",
      '["!room:example.org"]',
    );
    expect(configField("matrix", "MATRIX_ALLOWED_ROOMS")).not.toBeNull();
  });
});
