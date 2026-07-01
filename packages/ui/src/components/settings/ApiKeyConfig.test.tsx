// @vitest-environment jsdom
//
// Behavioral coverage for the provider API-key configuration surface.
//
// SURFACE MAPPING: the FOCUS ("provider-card") bundles four behaviors —
// enter+persist an API key, connected/needs-setup state, enable/disable a
// provider, and error-on-bad-key. The named `ProviderCard` component is only a
// compact selection chip (a button that fires `onSelect(id)`); it holds the
// enable/disable-via-select behavior. The key-entry → persist → masking →
// configured/needs-setup → bad-key-error semantics all live in `ApiKeyConfig`
// (the panel `ProviderCard` selection reveals). Both real units are covered
// here; only their collaborators (`../../api` client, the app-store `t`
// selector, the agent-surface hook) are mocked — the ConfigRenderer credential
// form, the 4-stage validation pipeline, and the save state machine all run for
// real.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// STABLE `t` — a fresh function per render would change the `useAppSelector`
// selection every render and re-fire `[t]`-keyed effects → render loop. Mirror
// the real stable translator: return the caller's defaultValue else the key.
const appValue = vi.hoisted(() => ({
  t: (key: string, options?: { defaultValue?: string; count?: number }) =>
    options?.defaultValue ?? key,
}));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (v: typeof appValue) => unknown) => sel(appValue),
  useAppSelectorShallow: (sel: (v: typeof appValue) => unknown) => sel(appValue),
}));

// Agent-surface hook returns STABLE-shaped no-op wiring (fresh {} is fine — it
// is spread onto DOM, never used as an effect dep).
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// The provider client is only touched by "fetch models" (not under test here).
vi.mock("../../api", () => ({ client: { fetchModels: vi.fn() } }));

import type { PluginParamDef } from "@elizaos/shared";
import { ApiKeyConfig } from "./ApiKeyConfig";
import { ProviderCard } from "./ProviderCard";

type ProviderPlugin = Parameters<
  typeof ApiKeyConfig
>[0]["selectedProvider"] & object;

const OPENAI_KEY_PARAM: PluginParamDef = {
  key: "OPENAI_API_KEY",
  type: "string",
  description: "OpenAI API key",
  required: true,
  sensitive: true,
  currentValue: null,
  isSet: false,
};

function makeProvider(over: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return {
    id: "openai",
    name: "OpenAI",
    parameters: [OPENAI_KEY_PARAM],
    configured: false,
    enabled: true,
    category: "key",
    ...over,
  } as ProviderPlugin;
}

interface Harness {
  save: ReturnType<typeof vi.fn>;
  loadPlugins: ReturnType<typeof vi.fn>;
  container: HTMLElement;
  keyInput: HTMLInputElement;
  saveButton: HTMLButtonElement;
}

function renderConfig(
  provider: ProviderPlugin,
  opts: { saving?: string[]; success?: string[] } = {},
): Harness {
  const save = vi.fn();
  const loadPlugins = vi.fn().mockResolvedValue(undefined);
  const { container } = render(
    <ApiKeyConfig
      selectedProvider={provider}
      pluginSaving={new Set(opts.saving ?? [])}
      pluginSaveSuccess={new Set(opts.success ?? [])}
      handlePluginConfigSave={save}
      loadPlugins={loadPlugins}
    />,
  );
  const keyInput = container.querySelector<HTMLInputElement>(
    'input[data-config-key="OPENAI_API_KEY"]',
  ) as HTMLInputElement;
  const saveButton = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) =>
    ["common.save", "common.saving", "common.saved"].includes(
      b.textContent ?? "",
    ),
  ) as HTMLButtonElement;
  return { save, loadPlugins, container, keyInput, saveButton };
}

afterEach(cleanup);

describe("ApiKeyConfig — key entry + persistence", () => {
  it("persists the entered key: save fires once with the exact field payload", () => {
    const provider = makeProvider();
    const { save, keyInput, saveButton } = renderConfig(provider);

    expect(keyInput).toBeTruthy();
    fireEvent.change(keyInput, { target: { value: "sk-live-abcd1234" } });
    fireEvent.click(saveButton);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("openai", {
      OPENAI_API_KEY: "sk-live-abcd1234",
    });
  });

  it("masks the credential input while preserving the typed value round-trip", () => {
    const { keyInput } = renderConfig(makeProvider());
    // Sensitive credential → password renderer (masked display), not plaintext.
    expect(keyInput.type).toBe("password");
    fireEvent.change(keyInput, { target: { value: "sk-secret-xyz" } });
    // Value is retained (round-trips through onChange) though visually masked.
    expect(keyInput.value).toBe("sk-secret-xyz");
  });

  it("blocks save on an empty required credential (no persist, required error shown)", () => {
    const provider = makeProvider();
    const { save, saveButton, container } = renderConfig(provider);

    fireEvent.click(saveButton);

    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This field is required.");
  });
});

describe("ApiKeyConfig — bad-key validation", () => {
  it("rejects a key with the wrong prefix: shows the hint error and does not persist", () => {
    const provider = makeProvider();
    const { save, keyInput, saveButton, container } = renderConfig(provider);

    fireEvent.change(keyInput, { target: { value: "totally-wrong-key" } });
    fireEvent.click(saveButton);

    expect(save).not.toHaveBeenCalled();
    // Prefix hint for OPENAI_API_KEY → keys must start with "sk-".
    expect(container.textContent).toContain('OpenAI keys start with "sk-".');
  });

  it("accepts a correctly-prefixed key that was previously rejected", () => {
    const provider = makeProvider();
    const { save, keyInput, saveButton, container } = renderConfig(provider);

    fireEvent.change(keyInput, { target: { value: "bad" } });
    fireEvent.click(saveButton);
    expect(save).not.toHaveBeenCalled();

    fireEvent.change(keyInput, { target: { value: "sk-good-1" } });
    fireEvent.click(saveButton);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("openai", { OPENAI_API_KEY: "sk-good-1" });
    expect(container.textContent).not.toContain('OpenAI keys start with "sk-".');
  });
});

describe("ApiKeyConfig — connected / needs-setup state", () => {
  it("shows the NeedsSetup badge when the provider is not configured", () => {
    const { container } = renderConfig(makeProvider({ configured: false }));
    expect(container.textContent).toContain("mediasettingssection.NeedsSetup");
    expect(container.textContent).not.toContain("config-field.Configured");
  });

  it("shows the Configured badge when the provider is configured", () => {
    const provider = makeProvider({
      configured: true,
      parameters: [{ ...OPENAI_KEY_PARAM, isSet: true, currentValue: "sk-***" }],
    });
    const { container } = renderConfig(provider);
    expect(container.textContent).toContain("config-field.Configured");
  });

  it("renders server-side validation errors against the saved config", () => {
    const provider = makeProvider({
      validationErrors: [
        { field: "OPENAI_API_KEY", message: "Key was revoked" },
      ],
    });
    const { container } = renderConfig(provider);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Key was revoked");
  });
});

describe("ApiKeyConfig — save state machine / rapid-fire idempotency", () => {
  it("disables the save button and no-ops clicks while a save is in flight", () => {
    const provider = makeProvider();
    const { save, keyInput, saveButton } = renderConfig(provider, {
      saving: ["openai"],
    });

    // In-flight save → button reflects saving state and is disabled.
    expect(saveButton.textContent).toBe("common.saving");
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(keyInput, { target: { value: "sk-inflight" } });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(save).not.toHaveBeenCalled();
  });

  it("reflects the saved-success state after a completed save", () => {
    const { saveButton } = renderConfig(makeProvider(), { success: ["openai"] });
    expect(saveButton.textContent).toBe("common.saved");
  });

  it("returns null when the provider exposes no parameters", () => {
    const { container } = renderConfig(
      makeProvider({ parameters: [] }),
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("ProviderCard — enable/disable via selection", () => {
  const Icon = ({ className }: { className?: string }) => (
    <svg className={className} data-testid="icon" />
  );

  function renderCard(over: Partial<Parameters<typeof ProviderCard>[0]> = {}) {
    const onSelect = vi.fn();
    const { container } = render(
      <ProviderCard
        id="openai"
        icon={Icon}
        label="OpenAI"
        category="key"
        status={{ tone: "warn", label: "Needs setup" }}
        current={false}
        selected={false}
        onSelect={onSelect}
        {...over}
      />,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    return { onSelect, button };
  }

  it("fires onSelect(id) exactly once when the chip is clicked", () => {
    const { onSelect, button } = renderCard();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("openai");
  });

  it("marks the selected chip with aria-current and its state label", () => {
    const { button } = renderCard({
      selected: true,
      status: { tone: "ok", label: "Ready" },
    });
    expect(button.getAttribute("aria-current")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("OpenAI, Ready");
  });

  it("labels the active (current) provider as Active regardless of status", () => {
    const { button } = renderCard({
      current: true,
      status: { tone: "warn", label: "Needs setup" },
    });
    expect(button.getAttribute("aria-label")).toBe("OpenAI, Active");
    // No aria-current unless it is the selected chip.
    expect(button.getAttribute("aria-current")).toBeNull();
  });

  it("does not fire selection on render (no eager enable)", () => {
    const { onSelect } = renderCard();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
