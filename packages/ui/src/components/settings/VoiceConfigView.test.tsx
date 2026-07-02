// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSwabblePlugin } from "../../bridge/native-plugins";
import { VoiceConfigView } from "./VoiceConfigView";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const appState = vi.hoisted(() => ({
  value: {
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
    elizaCloudConnected: false,
    elizaCloudVoiceProxyAvailable: false,
    characterData: { name: "eliza" },
    agentStatus: { agentName: "eliza" },
  },
}));

const clientMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

const swabbleMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  isListening: vi.fn(),
  addListener: vi.fn(),
  updateConfig: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../../api", () => ({
  client: clientMock,
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: () => ({ ref: null, agentProps: {} }),
}));

vi.mock("../../bridge/native-plugins", () => ({
  getSwabblePlugin: vi.fn(() => swabbleMock),
}));

vi.mock("../../hooks/useDefaultProviderPresets", () => ({
  useDefaultProviderPresets: () => ({
    defaults: { tts: "edge", asr: "browser" },
  }),
}));

vi.mock("./AdvancedToggle", () => ({
  AdvancedToggle: () => null,
}));

vi.mock("./AdvancedToggle.hooks", () => ({
  readPersistedAdvancedFlag: () => false,
  useAdvancedSettingsEnabled: () => false,
}));

vi.mock("../../state", () => ({
  useAppSelector: <T,>(selector: (state: typeof appState.value) => T): T =>
    selector(appState.value),
}));

describe("VoiceConfigView Swabble audio meter listener lifecycle", () => {
  beforeEach(() => {
    clientMock.getConfig.mockResolvedValue({
      messages: { tts: { provider: "edge" } },
    });
    clientMock.updateConfig.mockResolvedValue(undefined);
    swabbleMock.getConfig.mockResolvedValue({ config: null });
    swabbleMock.isListening.mockResolvedValue({ listening: false });
    swabbleMock.updateConfig.mockResolvedValue(undefined);
    swabbleMock.start.mockResolvedValue({ started: true });
    swabbleMock.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("removes an audioLevel listener that resolves after unmount", async () => {
    const addListener = deferred<{ remove: () => Promise<void> }>();
    const remove = vi.fn().mockResolvedValue(undefined);
    swabbleMock.addListener.mockReturnValue(addListener.promise);

    const { unmount } = render(<VoiceConfigView />);

    await waitFor(() =>
      expect(swabbleMock.addListener).toHaveBeenCalledWith(
        "audioLevel",
        expect.any(Function),
      ),
    );

    unmount();
    addListener.resolve({ remove });

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(getSwabblePlugin).toHaveBeenCalled();
  });
});
