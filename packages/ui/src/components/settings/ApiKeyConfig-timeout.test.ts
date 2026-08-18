/**
 * Exercises the production credential-reveal callback through ApiKeyConfig's
 * real ConfigRenderer boundary with only the shared API client mocked.
 */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientFetch: vi.fn(),
  revealSecret: undefined as
    | ((pluginId: string, key: string) => Promise<string | null>)
    | undefined,
}));

vi.mock("../../api", () => ({
  client: { fetch: mocks.clientFetch, fetchModels: vi.fn() },
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../state", () => ({
  useAppSelector: (fn: (s: { t: (k: string) => string }) => unknown) =>
    fn({ t: (k: string) => k }),
}));

vi.mock("../../hooks/useTimeout", () => ({
  useTimeout: () => ({ setTimeout: (fn: () => void) => fn() }),
}));

vi.mock("../RoleGate", () => ({
  RoleGate: ({ children }: { children: unknown }) => children,
  OwnerOnlyNotice: () => null,
}));

vi.mock("./settings-agent-rows", () => ({
  SettingsActionButton: () => null,
}));

vi.mock("./settings-control-primitives", () => ({
  AdvancedSettingsDisclosure: () => null,
}));

vi.mock("../../components/config-ui/config-renderer.helpers", () => ({
  defaultRegistry: {},
  useConfigValidation: () => ({
    configRef: { current: null },
    validateAll: () => true,
  }),
}));

vi.mock("../../components/config-ui/config-renderer", () => ({
  ConfigRenderer: (props: {
    revealSecret?: (pluginId: string, key: string) => Promise<string | null>;
  }) => {
    mocks.revealSecret = props.revealSecret;
    return null;
  },
}));

vi.mock("../../config/api-key-prefix-hints", () => ({
  API_KEY_PREFIX_HINTS: {},
}));

vi.mock("../../config/config-catalog", () => ({}));

vi.mock("../../utils/labels", () => ({
  autoLabel: (key: string) => key,
}));

import { ApiKeyConfig, type ApiKeyConfigProps } from "./ApiKeyConfig";

const props: ApiKeyConfigProps = {
  selectedProvider: {
    id: "provider/one",
    name: "Provider One",
    parameters: [
      {
        key: "PROVIDER_API_KEY",
        type: "string",
        description: "Provider API key",
        required: true,
        sensitive: true,
        currentValue: null,
        isSet: true,
      },
    ],
    configured: true,
    enabled: true,
    category: "model-provider",
  },
  pluginSaving: new Set(),
  pluginSaveSuccess: new Set(),
  handlePluginConfigSave: vi.fn(),
  loadPlugins: vi.fn(async () => {}),
};

function getProductionReveal(): (
  pluginId: string,
  key: string,
) => Promise<string | null> {
  render(createElement(ApiKeyConfig, props));
  if (!mocks.revealSecret) {
    throw new Error("ConfigRenderer did not receive revealSecret");
  }
  return mocks.revealSecret;
}

describe("ApiKeyConfig reveal deadline", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.revealSecret = undefined;
  });

  it("routes the production reveal through the canonical bounded client", async () => {
    mocks.clientFetch.mockResolvedValue({ value: "sk-test" });

    await expect(
      getProductionReveal()("provider/one", "PROVIDER_API_KEY"),
    ).resolves.toBe("sk-test");

    expect(mocks.clientFetch).toHaveBeenCalledWith(
      "/api/plugins/provider%2Fone/reveal",
      {
        method: "POST",
        body: JSON.stringify({ key: "PROVIDER_API_KEY" }),
      },
      { timeoutMs: 15_000 },
    );
  });

  it("keeps the credential masked when the bounded client rejects", async () => {
    mocks.clientFetch.mockRejectedValue(new Error("request timed out"));

    await expect(
      getProductionReveal()("provider/one", "PROVIDER_API_KEY"),
    ).resolves.toBeNull();
  });

  it("rejects malformed reveal payloads without fabricating a value", async () => {
    mocks.clientFetch.mockResolvedValue({ value: 42 });

    await expect(
      getProductionReveal()("provider/one", "PROVIDER_API_KEY"),
    ).resolves.toBeNull();
  });
});
