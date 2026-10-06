/** Verifies the canonical voice-preset editor through its rendered controls. */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => undefined;
Element.prototype.releasePointerCapture = () => undefined;

const appMock = vi.hoisted(() => ({
  elizaCloudConnected: false,
  elizaCloudVoiceProxyAvailable: false,
  t: (
    key: string,
    options?: { defaultValue?: string; [name: string]: unknown },
  ) => options?.defaultValue ?? key,
}));
const clientMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (selector: (state: typeof appMock) => unknown) =>
    selector(appMock),
}));

import { VoicePresetSettingsContent } from "./IdentitySettingsSection";

beforeEach(() => {
  vi.clearAllMocks();
  clientMock.getConfig
    .mockRejectedValueOnce(new Error("config fetch down"))
    .mockResolvedValue({
      messages: {
        tts: {
          provider: "elevenlabs",
          mode: "own-key",
          elevenlabs: {
            apiKey: "existing-secret",
            modelId: "existing-model",
            voiceId: "existing-voice",
          },
        },
      },
    });
  clientMock.updateConfig.mockResolvedValue({});
});

afterEach(cleanup);

it("preserves hidden TTS settings when the initial read fails before a voice save", async () => {
  const user = userEvent.setup();
  render(<VoicePresetSettingsContent />);
  await waitFor(() => expect(clientMock.getConfig).toHaveBeenCalledOnce());

  await user.click(screen.getByRole("combobox"));
  await user.keyboard("[ArrowDown][Enter]");
  await user.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(clientMock.updateConfig).toHaveBeenCalledOnce());

  expect(clientMock.updateConfig.mock.calls[0]?.[0]).toEqual({
    messages: {
      tts: {
        provider: "edge",
        mode: "own-key",
        edge: { voice: "en-US-GuyNeural" },
        elevenlabs: {
          apiKey: "existing-secret",
          modelId: "existing-model",
          voiceId: "existing-voice",
        },
      },
    },
  });
});

it("does not write voice settings when the save-time read also fails", async () => {
  clientMock.getConfig.mockReset();
  clientMock.getConfig.mockRejectedValue(new Error("config fetch down"));
  const user = userEvent.setup();
  render(<VoicePresetSettingsContent />);
  await waitFor(() => expect(clientMock.getConfig).toHaveBeenCalled());

  await user.click(screen.getByRole("combobox"));
  await user.keyboard("[ArrowDown][Enter]");
  await user.click(screen.getByRole("button", { name: "Save Changes" }));

  await screen.findByText(
    "Voice settings could not be read, so the save was skipped and the existing key was left unchanged.",
  );
  expect(clientMock.updateConfig).not.toHaveBeenCalled();
});
