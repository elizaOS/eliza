// @vitest-environment jsdom
/**
 * Behavioural tests for CharacterEditor (the companion/overlay editor shell).
 *
 * The unit under test is CharacterEditor. Its real collaborators are:
 *   - the app selector store (seeded via __setAppValueForTests) — supplies the
 *     character draft + the field/save handlers the editor wires its controls to.
 *   - the `client` API singleton — voice-config persistence on save.
 *   - the voice hooks (useVoiceChat / useChatAvatarVoiceBridge) — audio side
 *     effects irrelevant to editor behaviour.
 *   - DocumentsView — the knowledge sub-page (its own unit; document upload lives
 *     there, so it is mocked to a marker here).
 * Everything else (the identity/style panels, the roster, the tab bar, the
 * unsaved-changes gating, the VRM upload input) is REAL and exercised.
 *
 * Note on field coverage: the editor has no free-text name/system inputs — those
 * fields round-trip through the store field handler only via preset application
 * (Reset to defaults). Bio has a real textarea. Both paths are asserted below.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getStylePresets } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";

const clientMock = vi.hoisted(() => ({
  getConfig: vi.fn(async () => ({}) as Record<string, unknown>),
  updateConfig: vi.fn(async () => ({}) as Record<string, unknown>),
  updateCharacter: vi.fn(async () => ({}) as Record<string, unknown>),
  getDropStatus: vi.fn(async () => ({}) as Record<string, unknown>),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, client: clientMock };
});

// Voice hooks pull in audio/media machinery irrelevant to editor behaviour.
// Return STABLE references so the useEffect deps that read them don't loop.
const stableVoice = {
  mouthOpen: 0,
  isSpeaking: false,
  speak: vi.fn(),
  stopSpeaking: vi.fn(),
};
vi.mock("../../hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useVoiceChat: () => stableVoice,
    useChatAvatarVoiceBridge: () => {},
  };
});

// DocumentsView is the knowledge sub-page (its own unit). Mock to a marker so
// selecting the Documents tab is observable without booting its data layer.
vi.mock("../pages/DocumentsView", () => ({
  DocumentsView: () => <div data-testid="documents-view-mock" />,
}));

import { CharacterEditor } from "./CharacterEditor";

// jsdom has no matchMedia; the overlay camera-offset effect calls it on mount.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

const preset = getStylePresets("en")[0];
const PRESET_NAME = preset.name;

type SeedHandlers = {
  handleCharacterFieldInput: ReturnType<typeof vi.fn>;
  handleCharacterStyleInput: ReturnType<typeof vi.fn>;
  handleSaveCharacter: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  setTab: ReturnType<typeof vi.fn>;
};

function makeState(overrides: Record<string, unknown> = {}) {
  const handlers: SeedHandlers = {
    handleCharacterFieldInput: vi.fn(),
    handleCharacterStyleInput: vi.fn(),
    handleSaveCharacter: vi.fn(async () => {}),
    setState: vi.fn(),
    setTab: vi.fn(),
  };
  const value = {
    tab: "character",
    setTab: handlers.setTab,
    // A named, non-empty draft that matches preset[0] so the auto-select
    // resolves to that roster entry WITHOUT re-applying defaults on mount
    // (name matches → shouldApplyPresetDefaults=false).
    characterData: { name: PRESET_NAME },
    characterDraft: {
      name: PRESET_NAME,
      username: PRESET_NAME,
      bio: "Original bio line",
      system: "Original system prompt",
      adjectives: [],
      style: { all: [], chat: [], post: [] },
      messageExamples: [],
      postExamples: [],
    },
    characterLoading: false,
    characterSaving: false,
    characterSaveSuccess: null,
    chatAgentVoiceMuted: false,
    characterSaveError: null,
    handleCharacterFieldInput: handlers.handleCharacterFieldInput,
    handleCharacterStyleInput: handlers.handleCharacterStyleInput,
    handleSaveCharacter: handlers.handleSaveCharacter,
    loadCharacter: vi.fn(),
    setState: handlers.setState,
    firstRunOptions: {},
    selectedVrmIndex: preset.avatarIndex ?? 1,
    customVrmUrl: null,
    customVrmPreviewUrl: null,
    customCatchphrase: null,
    customVoicePresetId: null,
    activePackId: null,
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    uiLanguage: "en",
    registryStatus: null,
    registryLoading: false,
    registryRegistering: false,
    registryError: null,
    dropStatus: null,
    loadRegistryStatus: vi.fn(),
    registerOnChain: vi.fn(),
    syncRegistryProfile: vi.fn(),
    loadDropStatus: vi.fn(),
    walletConfig: null,
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    ...overrides,
  };
  return { value, handlers };
}

/** Render the overlay editor and enter the "Customize" tabbed editor. */
async function renderCustomizing(overrides: Record<string, unknown> = {}) {
  const { value, handlers } = makeState(overrides);
  __setAppValueForTests(value as never);
  const view = render(<CharacterEditor sceneOverlay />);
  const customizeBtn = await screen.findByRole("button", { name: "Customize" });
  // Drop mount-time calls (auto-select fires setState / voice config) so
  // assertions target only the interaction under test.
  clientMock.getConfig.mockClear();
  clientMock.updateConfig.mockClear();
  handlers.handleCharacterFieldInput.mockClear();
  handlers.handleSaveCharacter.mockClear();
  handlers.setState.mockClear();
  fireEvent.click(customizeBtn);
  return { ...view, handlers };
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  vi.clearAllMocks();
});

describe("CharacterEditor", () => {
  it("round-trips a bio edit to the store field handler with the typed value", async () => {
    const { handlers } = await renderCustomizing();

    const bio = screen.getByPlaceholderText("Describe who your agent is...");
    fireEvent.change(bio, { target: { value: "A brand new backstory" } });

    expect(handlers.handleCharacterFieldInput).toHaveBeenCalledWith(
      "bio",
      "A brand new backstory",
    );
  });

  it("gates Save until a field is dirtied, then persists voice config + character", async () => {
    const { handlers } = await renderCustomizing();

    const save = screen.getByRole("button", { name: "Save" });
    // No pending changes on entry → Save is inert (disabled buttons don't fire).
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(handlers.handleSaveCharacter).not.toHaveBeenCalled();

    // Dirty a field → Save becomes actionable.
    fireEvent.change(
      screen.getByPlaceholderText("Describe who your agent is..."),
      { target: { value: "edited bio" } },
    );
    expect((save as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(save);

    await waitFor(() =>
      expect(handlers.handleSaveCharacter).toHaveBeenCalledTimes(1),
    );
    // handleSaveAll persists the voice config first (edge provider by default).
    expect(clientMock.updateConfig).toHaveBeenCalledWith({
      messages: { tts: expect.objectContaining({ provider: "edge" }) },
    });
  });

  it("is idempotent under a rapid double-click on Save (the second click is a no-op)", async () => {
    const { handlers } = await renderCustomizing();
    fireEvent.change(
      screen.getByPlaceholderText("Describe who your agent is..."),
      { target: { value: "edited bio" } },
    );
    const save = screen.getByRole("button", { name: "Save" });

    // Two clicks in quick succession: the first flips the saving state and
    // disables the button before the second lands.
    fireEvent.click(save);
    fireEvent.click(save);

    await waitFor(() =>
      expect(handlers.handleSaveCharacter).toHaveBeenCalledTimes(1),
    );
    // After the save completes, the dirty flag clears → Save disabled again.
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(true),
    );
    fireEvent.click(save);
    expect(handlers.handleSaveCharacter).toHaveBeenCalledTimes(1);
  });

  it("switches the active editor tab and moves the selected state", async () => {
    await renderCustomizing();

    const personalityTab = screen.getByRole("tab", { name: "Personality" });
    const stylesTab = screen.getByRole("tab", { name: "Styles" });
    expect(personalityTab.getAttribute("aria-selected")).toBe("true");
    expect(stylesTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(stylesTab);

    expect(stylesTab.getAttribute("aria-selected")).toBe("true");
    expect(personalityTab.getAttribute("aria-selected")).toBe("false");
    expect(stylesTab.getAttribute("aria-controls")).toBe(
      "character-editor-panel-style",
    );
  });

  it("opens the Documents sub-page and hides the character action bar there", async () => {
    await renderCustomizing();

    // Action bar (with Save) present on the personality page.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Knowledge" }));

    expect(screen.getByTestId("documents-view-mock")).not.toBeNull();
    // The Save/Reset/Upload action row is not rendered on the documents page.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("routes name + system + bio through the field handler when resetting to preset defaults", async () => {
    const { handlers } = await renderCustomizing();

    const reset = screen.getByRole("button", { name: "Reset" });
    expect((reset as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(reset);

    const editedFields = handlers.handleCharacterFieldInput.mock.calls.map(
      (call) => call[0],
    );
    expect(editedFields).toContain("name");
    expect(editedFields).toContain("system");
    expect(editedFields).toContain("bio");
    // Name resolves to the roster entry's preset name.
    expect(handlers.handleCharacterFieldInput).toHaveBeenCalledWith(
      "name",
      PRESET_NAME,
    );
  });

  it("selects the uploaded avatar when a VRM file is chosen", async () => {
    const { value, handlers } = makeState();
    __setAppValueForTests(value as never);
    const { container } = render(<CharacterEditor sceneOverlay />);
    await screen.findByRole("button", { name: "Customize" });
    handlers.setState.mockClear();

    const input = container.querySelector<HTMLInputElement>("#ce-vrm-upload");
    expect(input).not.toBeNull();

    const file = new File(["vrm-bytes"], "avatar.vrm", { type: "model/vrm" });
    fireEvent.change(input as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(handlers.setState).toHaveBeenCalledWith("selectedVrmIndex", 0);
    // The input is reset so re-picking the same file re-fires change.
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not select an avatar when the VRM file picker is cancelled (no file)", async () => {
    const { value, handlers } = makeState();
    __setAppValueForTests(value as never);
    const { container } = render(<CharacterEditor sceneOverlay />);
    await screen.findByRole("button", { name: "Customize" });
    handlers.setState.mockClear();

    const input = container.querySelector<HTMLInputElement>("#ce-vrm-upload");
    fireEvent.change(input as HTMLInputElement, { target: { files: [] } });

    expect(handlers.setState).not.toHaveBeenCalledWith("selectedVrmIndex", 0);
  });
});
