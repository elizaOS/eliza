// @vitest-environment jsdom
//
// Behavioral test for IdentitySettingsSection — the agent-identity settings
// subview (name + system-prompt basics, plus voice preset). Drives the real
// component and asserts the persistence contract against a mocked store + API
// client:
//   - name/system edits route the exact edited value to the store field writer
//   - a dirty draft surfaces the Save footer; a clean draft hides it (the gate)
//   - Save fires handleSaveCharacter exactly once and does NOT touch the voice
//     config API when only the character basics changed
//   - rapid double-click on Save does not fan out into duplicate persistence
//   - the initial-load effect requests the character once when nothing is loaded
//
// Collaborators mocked: the app store (`__setAppValueForTests`) and the API
// client (`getConfig`/`updateConfig`). The component itself is never mocked.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import { IdentitySettingsSection } from "./IdentitySettingsSection";

const { getConfig, updateConfig } = vi.hoisted(() => ({
  getConfig: vi.fn(async () => ({ messages: {} })),
  updateConfig: vi.fn(async () => ({}) as never),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    client: { getConfig, updateConfig },
  };
});

// Stable across re-seeds so hooks that memo on `t` don't churn / loop.
const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

interface SeedOverrides {
  characterData?: { name?: string; system?: string } | null;
  characterDraft?: { name?: string; system?: string };
  characterLoading?: boolean;
  handleCharacterFieldInput?: (field: string, value: string) => void;
  handleSaveCharacter?: () => Promise<void>;
  loadCharacter?: () => Promise<void>;
  elizaCloudConnected?: boolean;
  elizaCloudVoiceProxyAvailable?: boolean;
}

function seed(overrides: SeedOverrides = {}) {
  const value = {
    t,
    characterData: overrides.characterData ?? null,
    characterDraft: overrides.characterDraft ?? {},
    characterLoading: overrides.characterLoading ?? false,
    handleCharacterFieldInput: overrides.handleCharacterFieldInput ?? vi.fn(),
    handleSaveCharacter: overrides.handleSaveCharacter ?? vi.fn(async () => {}),
    loadCharacter: overrides.loadCharacter ?? vi.fn(async () => {}),
    elizaCloudConnected: overrides.elizaCloudConnected ?? false,
    elizaCloudVoiceProxyAvailable:
      overrides.elizaCloudVoiceProxyAvailable ?? false,
  };
  __setAppValueForTests(value as never);
  return value;
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}

function saveButton(): HTMLButtonElement | null {
  return screen.queryByRole("button", {
    name: "Save Changes",
  }) as HTMLButtonElement | null;
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("IdentitySettingsSection", () => {
  it("routes the exact edited name value to the store field writer", async () => {
    const handleCharacterFieldInput = vi.fn();
    seed({
      characterData: { name: "Aria", system: "" },
      characterDraft: { name: "Aria", system: "" },
      handleCharacterFieldInput,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    // Surrounding whitespace is intentional: the field writer must receive the
    // raw keystroke value verbatim (no trim/normalize) so trailing spaces the
    // user is mid-typing survive the round-trip.
    fireEvent.change(nameInput(), { target: { value: "  Nova the Agent " } });

    expect(handleCharacterFieldInput).toHaveBeenCalledTimes(1);
    expect(handleCharacterFieldInput).toHaveBeenCalledWith(
      "name",
      "  Nova the Agent ",
    );
  });

  it("routes system-prompt edits to the store without mangling adversarial input", async () => {
    const handleCharacterFieldInput = vi.fn();
    seed({
      characterData: { name: "Aria", system: "" },
      characterDraft: { name: "Aria", system: "" },
      handleCharacterFieldInput,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    const adversarial = "  <script>{{name}}</script>\n\ttrailing  ";
    fireEvent.change(screen.getByLabelText("System prompt"), {
      target: { value: adversarial },
    });

    expect(handleCharacterFieldInput).toHaveBeenCalledWith("system", adversarial);
  });

  it("hides the Save footer when the draft matches the saved character (dirty gate)", async () => {
    seed({
      characterData: { name: "Aria", system: "Hello" },
      characterDraft: { name: "Aria", system: "Hello" },
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    expect(saveButton()).toBeNull();
  });

  it("shows the Save footer once the draft diverges and persists via handleSaveCharacter only", async () => {
    const handleSaveCharacter = vi.fn(async () => {});
    seed({
      characterData: { name: "Aria", system: "Hello" },
      characterDraft: { name: "Nova", system: "Hello" },
      handleSaveCharacter,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    const button = saveButton();
    expect(button).not.toBeNull();

    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() => expect(handleSaveCharacter).toHaveBeenCalledTimes(1));
    // Character-only edit must NOT rewrite the voice/tts config.
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("does not fan a rapid double-click into duplicate character saves", async () => {
    let resolveSave: (() => void) | null = null;
    const handleSaveCharacter = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    seed({
      characterData: { name: "Aria", system: "Hello" },
      characterDraft: { name: "Nova", system: "Hello" },
      handleSaveCharacter,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    const button = saveButton() as HTMLButtonElement;
    fireEvent.click(button);
    // Second click while the first save is still in-flight (button disabled).
    fireEvent.click(button);

    expect(handleSaveCharacter).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);

    resolveSave?.();
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it("requests the character once on mount when nothing is loaded yet", async () => {
    const loadCharacter = vi.fn(async () => {});
    seed({
      characterData: null,
      characterDraft: {},
      characterLoading: false,
      loadCharacter,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(loadCharacter).toHaveBeenCalledTimes(1));
    // Guarded by an attempt-once ref: it must not re-fire on subsequent
    // re-renders (e.g. from the voice-config effect settling).
    await Promise.resolve();
    expect(loadCharacter).toHaveBeenCalledTimes(1);
  });

  it("surfaces the save error and keeps the footer open when persistence throws", async () => {
    const handleSaveCharacter = vi.fn(async () => {
      throw new Error("write conflict");
    });
    seed({
      characterData: { name: "Aria", system: "Hello" },
      characterDraft: { name: "Nova", system: "Hello" },
      handleSaveCharacter,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    fireEvent.click(saveButton() as HTMLButtonElement);

    await waitFor(() =>
      expect(screen.getByText("write conflict")).not.toBeNull(),
    );
    // Still dirty, so the footer (and Save button) remain available to retry.
    expect(saveButton()).not.toBeNull();
  });

  // Characterization: there is currently NO empty-name validation gate. Clearing
  // the name leaves the draft dirty and Save fires with the empty value straight
  // through to persistence. If a real min-length/required gate is added, this
  // assertion should flip — it documents the present (ungated) behavior.
  it("does not gate an emptied name — Save still fires (documents missing validation)", async () => {
    const handleSaveCharacter = vi.fn(async () => {});
    seed({
      characterData: { name: "Aria", system: "Hello" },
      characterDraft: { name: "", system: "Hello" },
      handleSaveCharacter,
    });

    render(<IdentitySettingsSection />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());

    const button = saveButton();
    expect(button).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button as HTMLButtonElement);
    await waitFor(() => expect(handleSaveCharacter).toHaveBeenCalledTimes(1));
  });
});
