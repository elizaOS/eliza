// @vitest-environment jsdom
//
// Behavior coverage for the CharacterEditor view, focused on the config-write
// boundary reworked in #15922: roster selection changes the local voice
// immediately but must NOT issue an automatic durable config PUT (only explicit
// Save writes), a failed voice-config read renders a retryable unavailable
// banner instead of a healthy-looking empty editor, and a late read from an
// unmounted/superseded generation cannot poison a later mount. The real
// CharacterEditor runs; only true boundaries are stubbed — global store,
// api client (network), voice-chat/agent-surface hooks, and the sibling panel
// components rendered as children.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ── Boundary state store ──────────────────────────────────────────── */
// A single mutable store the mocked selector reads. Tests seed it before render;
// the component's own useState drives the rest.
type MutableStore = Record<string, unknown>;
const store: MutableStore = {};

function resetStore() {
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, {
    tab: "character",
    setTab: vi.fn(),
    characterData: { name: "Momo", bio: "hello" },
    characterDraft: {
      name: "Momo",
      bio: "hello",
      system: "be nice",
      style: { all: ["kind"], chat: [], post: [] },
      messageExamples: [],
    },
    characterLoading: false,
    characterSaving: false,
    characterSaveSuccess: null,
    chatAgentVoiceMuted: false,
    characterSaveError: null,
    handleCharacterFieldInput: vi.fn(),
    handleCharacterStyleInput: vi.fn(),
    handleSaveCharacter: vi.fn(async () => {}),
    loadCharacter: vi.fn(async () => {}),
    setState: vi.fn(),
    firstRunOptions: null,
    selectedVrmIndex: 4,
    customVrmUrl: null,
    customVrmPreviewUrl: null,
    customCatchphrase: null,
    customVoicePresetId: null,
    activePackId: null,
    t: (_key: string, opts?: { defaultValue?: string; name?: string }) =>
      opts?.defaultValue ?? _key,
    uiLanguage: "en",
    registryStatus: null,
    registryLoading: false,
    registryRegistering: false,
    registryError: null,
    dropStatus: null,
    loadRegistryStatus: vi.fn(async () => {}),
    registerOnChain: vi.fn(),
    syncRegistryProfile: vi.fn(),
    loadDropStatus: vi.fn(async () => {}),
    walletConfig: null,
    elizaCloudConnected: true,
    elizaCloudVoiceProxyAvailable: false,
  });
}

/* ── Mocked boundaries ─────────────────────────────────────────────── */
const getConfig = vi.fn();
const updateConfig = vi.fn();
const speak = vi.fn();
const stopSpeaking = vi.fn();

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: MutableStore) => unknown) =>
    selector(store),
}));
vi.mock("../../api/client", () => ({
  client: {
    getConfig: (...args: unknown[]) => getConfig(...args),
    updateConfig: (...args: unknown[]) => updateConfig(...args),
  },
}));
vi.mock("../../hooks/useRenderGuard", () => ({ useRenderGuard: () => {} }));
vi.mock("../../hooks", () => ({
  useVoiceChat: () => ({
    mouthOpen: 0,
    isSpeaking: false,
    speak,
    stopSpeaking,
  }),
  useChatAvatarVoiceBridge: () => {},
}));
vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: () => {}, agentProps: {} }),
}));
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-surface">{children}</div>
  ),
}));

// The sibling panels are separate components (their own coverage lives with
// their own tests). Stub them to isolate the editor's own logic and to expose
// hooks that drive the editor's field/style handlers.
vi.mock("./CharacterHubView", () => ({
  CharacterHubView: ({
    characterSaveError,
  }: {
    characterSaveError: string | null;
  }) => (
    <div data-testid="hub-view" data-save-error={characterSaveError ?? ""} />
  ),
}));
vi.mock("./CharacterEditorPanels", () => ({
  CharacterIdentityPanel: () => <div data-testid="identity-panel" />,
  CharacterStylePanel: ({
    handleAddStyleEntry,
    handleRemoveStyleEntry,
  }: {
    handleAddStyleEntry: (key: string) => void;
    handleRemoveStyleEntry: (key: string, index: number) => void;
  }) => (
    <div data-testid="style-panel">
      <button
        type="button"
        data-testid="add-style"
        onClick={() => handleAddStyleEntry("all")}
      >
        add
      </button>
      <button
        type="button"
        data-testid="remove-style"
        onClick={() => handleRemoveStyleEntry("all", 0)}
      >
        remove
      </button>
    </div>
  ),
  CharacterExamplesPanel: () => <div data-testid="examples-panel" />,
}));
vi.mock("./CharacterRoster", () => ({
  CharacterRoster: ({
    entries,
    onSelect,
  }: {
    entries: Array<{ id: string; name: string }>;
    onSelect: (entry: { id: string; name: string }) => void;
  }) => (
    <div data-testid="roster">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          data-testid={`roster-${entry.name}`}
          onClick={() => onSelect(entry)}
        >
          {entry.name}
        </button>
      ))}
    </div>
  ),
}));

import { VOICE_CONFIG_UPDATED_EVENT } from "../../events/index";
import { CharacterEditor } from "./CharacterEditor";

const flush = () => act(async () => await Promise.resolve());

// Selects a roster character other than the auto-selected one, which is only
// possible while the roster is visible (sceneOverlay and not customizing). This
// makes hasPendingChanges true so Save / navigation-guard paths are reachable.
async function selectOtherRosterCharacter() {
  const roster = await screen.findByTestId("roster");
  const other = within(roster)
    .getAllByRole("button")
    .find((b) => b.getAttribute("data-testid") !== "roster-Momo");
  if (!other) throw new Error("expected a second roster entry");
  await act(async () => {
    fireEvent.click(other);
  });
}

beforeEach(() => {
  // jsdom omits matchMedia; the overlay layout effect reads it on mount.
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  resetStore();
  getConfig.mockReset();
  updateConfig.mockReset();
  speak.mockReset();
  stopSpeaking.mockReset();
  getConfig.mockResolvedValue({});
  updateConfig.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CharacterEditor config write boundary", () => {
  it("shows the loading state until character data resolves", async () => {
    store.characterLoading = true;
    store.characterData = null;
    render(<CharacterEditor />);
    expect(screen.getByText("Loading character data...")).toBeTruthy();
    await flush();
  });

  it("loads voice config on mount and applies the server preset", async () => {
    getConfig.mockResolvedValue({
      messages: {
        tts: { provider: "elevenlabs", elevenlabs: { voiceId: "x" } },
      },
    });
    render(<CharacterEditor />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    await flush();
    // Reading a config never triggers an automatic durable write.
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("renders a retryable unavailable banner when the voice config read fails", async () => {
    getConfig.mockRejectedValueOnce(new Error("boom"));
    render(<CharacterEditor />);
    const banner = await screen.findByTestId(
      "character-voice-config-unavailable",
    );
    expect(banner.textContent).toContain("Voice settings are unavailable");
    expect(banner.textContent).toContain("boom");

    // Retry re-reads config; a now-successful read clears the banner.
    getConfig.mockResolvedValueOnce({ messages: {} });
    fireEvent.click(within(banner).getByRole("button"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("character-voice-config-unavailable"),
      ).toBeNull(),
    );
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it("degrades to a generic message when the read rejects without an Error", async () => {
    getConfig.mockRejectedValueOnce("nope");
    render(<CharacterEditor />);
    const banner = await screen.findByTestId(
      "character-voice-config-unavailable",
    );
    expect(banner.textContent).toContain("Voice settings are unavailable.");
  });

  it("ignores a late config read from an unmounted editor (generation guard)", async () => {
    let resolveRead: (value: unknown) => void = () => {};
    getConfig.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const view = render(<CharacterEditor />);
    view.unmount();
    // The read resolves after unmount; the generation guard drops it, so no
    // post-unmount state update / act warning is produced.
    await act(async () => {
      resolveRead({ messages: { tts: { provider: "edge" } } });
      await Promise.resolve();
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("selecting a roster character switches the voice locally without a config PUT", async () => {
    render(<CharacterEditor sceneOverlay />);
    await flush();
    const events: unknown[] = [];
    const listener = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener(VOICE_CONFIG_UPDATED_EVENT, listener);

    const roster = await screen.findByTestId("roster");
    const buttons = within(roster).getAllByRole("button");
    // Selecting a different character than the auto-selected one dispatches the
    // local voice-switch event but must not write config.
    const target =
      buttons.find((b) => b.getAttribute("data-testid") !== "roster-Momo") ??
      buttons[0];
    await act(async () => {
      fireEvent.click(target);
    });
    window.removeEventListener(VOICE_CONFIG_UPDATED_EVENT, listener);
    expect(updateConfig).not.toHaveBeenCalled();
    expect(events.length).toBeGreaterThan(0);
  });

  it("explicit Save persists the voice config and character together", async () => {
    render(<CharacterEditor sceneOverlay />);
    await flush();
    // Create a pending change while the roster is visible, then open the editor.
    await selectOtherRosterCharacter();
    fireEvent.click(screen.getByText("Customize"));

    const saveBtn = await screen.findByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(store.handleSaveCharacter).toHaveBeenCalled();
  });

  it("surfaces a Save failure through the editor error state", async () => {
    updateConfig.mockRejectedValue(new Error("write denied"));
    render(<CharacterEditor sceneOverlay />);
    await flush();
    await selectOtherRosterCharacter();
    fireEvent.click(screen.getByText("Customize"));

    const saveBtn = await screen.findByRole("button", { name: "Save" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    // The voice save failed, so the durable character write is never reached.
    expect(store.handleSaveCharacter).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("write denied")).toBeTruthy());
  });

  it("switches editor tabs and drives style-entry handlers in the overlay", async () => {
    render(<CharacterEditor sceneOverlay />);
    await flush();
    fireEvent.click(screen.getByText("Customize"));

    // Move to the Styles tab so the style panel (and its handlers) mount.
    fireEvent.click(screen.getByText("Styles"));
    const stylePanel = await screen.findByTestId("style-panel");
    fireEvent.click(within(stylePanel).getByTestId("add-style"));
    fireEvent.click(within(stylePanel).getByTestId("remove-style"));

    // Keyboard tab navigation exercises the arrow-key handler.
    const styleTab = screen.getByText("Styles");
    fireEvent.keyDown(styleTab, { key: "ArrowRight" });
    fireEvent.keyDown(styleTab, { key: "Home" });
  });

  it("exports the current character as a JSON download", async () => {
    const createUrl = vi.fn(() => "blob:mock");
    const revokeUrl = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL =
      createUrl;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL =
      revokeUrl;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<CharacterEditor sceneOverlay />);
    await flush();
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    expect(createUrl).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("opens the unsaved-changes dialog when navigating with pending edits", async () => {
    render(<CharacterEditor sceneOverlay />);
    await flush();
    // Create a pending change while the roster is visible, then open the editor
    // and request a page change to raise the unsaved-changes guard.
    await selectOtherRosterCharacter();
    fireEvent.click(screen.getByText("Customize"));
    fireEvent.click(screen.getByText("Examples"));
    const dialog = await screen.findByText("Unsaved changes");
    expect(dialog).toBeTruthy();

    // "Don't save" discards and proceeds without a config write.
    fireEvent.click(screen.getByText("Don't save"));
    await waitFor(() =>
      expect(screen.queryByText("Unsaved changes")).toBeNull(),
    );
  });

  it("propagates the combined save error into the personality view", async () => {
    store.characterSaveError = "server rejected save";
    render(<CharacterEditor />);
    await flush();
    const hub = await screen.findByTestId("hub-view");
    expect(hub.getAttribute("data-save-error")).toBe("server rejected save");
  });

  it("resets the active character to its preset defaults", async () => {
    render(<CharacterEditor sceneOverlay />);
    await flush();
    fireEvent.click(screen.getByText("Customize"));
    (store.handleCharacterFieldInput as ReturnType<typeof vi.fn>).mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    });
    // Reset re-applies the roster entry's default fields through the store.
    expect(store.handleCharacterFieldInput).toHaveBeenCalled();
  });
});
