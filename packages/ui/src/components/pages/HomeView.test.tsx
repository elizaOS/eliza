// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "./HomeView";

type MockModelStatus = {
  kind: string;
  blocksSend: boolean;
  percent: number | null;
  etaMs: number | null;
  modelName: string | null;
  errors: string[];
};

const NOT_REQUIRED_STATUS: MockModelStatus = {
  kind: "not-required",
  blocksSend: false,
  percent: null,
  etaMs: null,
  modelName: null,
  errors: [],
};

const controllerMock = vi.hoisted(() => ({
  value: {
    waveformMode: "idle" as const,
    messages: [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "I can open any view and keep the conversation moving.",
        createdAt: 1,
      },
      {
        id: "user-1",
        role: "user" as const,
        content: "show me the views",
        createdAt: 2,
      },
    ],
    canSend: true,
    isOpen: true,
    modelStatus: {
      kind: "not-required",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    } as MockModelStatus,
    recording: false,
    open: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    toggleRecording: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  },
}));

const backgroundRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../homescreen/Homescreen", () => ({
  Homescreen: ({ phase }: { phase: string }) => {
    backgroundRenders.count += 1;
    return <div data-testid="homescreen" data-phase={phase} />;
  },
}));

vi.mock("../shell/ShellControllerContext", () => ({
  useShellControllerContext: () => controllerMock.value,
}));

afterEach(() => {
  cleanup();
  controllerMock.value.send.mockClear();
  controllerMock.value.toggleRecording.mockClear();
  controllerMock.value.startRecording.mockClear();
  controllerMock.value.stopRecording.mockClear();
  controllerMock.value.open.mockClear();
  controllerMock.value.close.mockClear();
  controllerMock.value.recording = false;
  controllerMock.value.canSend = true;
  controllerMock.value.isOpen = true;
  controllerMock.value.modelStatus = { ...NOT_REQUIRED_STATUS };
  backgroundRenders.count = 0;
});

function openHomeChatPanel() {
  const pill = screen.queryByTestId("home-chat-pill");
  if (!pill) return;
  fireEvent.pointerDown(pill, { clientY: 100 });
  fireEvent.pointerUp(pill, { clientY: 100 });
}

describe("HomeView", () => {
  it("renders the homescreen canvas, concise assistant transcript, and the home composer", () => {
    render(<HomeView />);

    expect(screen.getByTestId("homescreen")).toBeTruthy();
    expect(screen.getByTestId("home-assistant-transcript").textContent).toBe(
      "I can open any view and keep the conversation moving.",
    );
    openHomeChatPanel();
    expect(screen.getByTestId("home-chat-input")).toBeTruthy();
    expect(screen.getByTestId("home-chat-panel").className).toContain(
      "animate-[slide-up_180ms_ease-out]",
    );
  });

  it("requests chat open from a direct collapsed-pill click", () => {
    controllerMock.value.isOpen = false;

    render(<HomeView />);

    const pill = screen.getByTestId("home-chat-pill");
    expect(pill.className).toContain("mx-auto");
    expect(pill.className).toContain("w-40");
    expect(pill.className).toContain("backdrop-blur-2xl");
    expect(pill.className).toContain("hover:scale-[1.04]");
    expect(pill.className).toContain("focus-visible:outline-none");
    expect(pill.className).not.toContain("focus-visible:ring");
    expect(pill.textContent).not.toContain("Ask Eliza");

    fireEvent.click(pill);

    expect(controllerMock.value.open).toHaveBeenCalledTimes(1);
  });

  it("requests chat open from a plain pointer release on the collapsed pill", () => {
    controllerMock.value.isOpen = false;

    render(<HomeView />);

    const pill = screen.getByTestId("home-chat-pill");
    fireEvent.pointerDown(pill, { clientY: 100 });
    fireEvent.pointerUp(pill, { clientY: 112 });

    expect(controllerMock.value.open).toHaveBeenCalledTimes(1);
  });

  it("clicking the orb closes home chat and starts centered voice mode", () => {
    controllerMock.value.isOpen = true;

    render(<HomeView />);

    fireEvent.click(screen.getByTestId("home-orb-hit"));

    expect(controllerMock.value.close).toHaveBeenCalledTimes(1);
    expect(controllerMock.value.startRecording).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("home-orb-expanded")).toBeTruthy();
    expect(screen.getByTestId("home-view").className).toContain("opacity-0");
  });

  it("shows recent chats while typing and submits through the shared shell controller", () => {
    render(<HomeView />);
    openHomeChatPanel();

    const input = screen.getByTestId("home-chat-input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "open terminal" } });

    expect(screen.getByTestId("home-recent-chats").textContent).toContain(
      "show me the views",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(controllerMock.value.send).toHaveBeenCalledWith("open terminal");
    expect(input.value).toBe("");
  });

  it("never re-renders the homescreen background while typing into the composer", () => {
    render(<HomeView />);

    expect(backgroundRenders.count).toBe(1);
    openHomeChatPanel();

    const input = screen.getByTestId("home-chat-input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "h" } });
    fireEvent.change(input, { target: { value: "he" } });
    fireEvent.change(input, { target: { value: "hel" } });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.blur(input);

    // The memoized WebGL homescreen must stay mounted without a single extra
    // render across all of the composer's state churn — remounting it would tear
    // down and rebuild the renderer on every keystroke.
    expect(backgroundRenders.count).toBe(1);
  });

  it("shows a download progress bar under the avatar while the model installs", () => {
    controllerMock.value.modelStatus = {
      kind: "downloading",
      blocksSend: true,
      percent: 63,
      etaMs: 90_000,
      modelName: "Eliza 1",
      errors: [],
    };
    controllerMock.value.canSend = false;

    render(<HomeView />);

    const panel = screen.getByTestId("home-model-status");
    expect(panel.getAttribute("data-kind")).toBe("downloading");
    expect(panel.textContent).toContain("Eliza 1");
    expect(panel.textContent).toContain("63%");
    const bar = panel.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("63");
    // The assistant transcript is replaced by the status panel.
    expect(screen.queryByTestId("home-assistant-transcript")).toBeNull();
  });

  it("gates send while the local model blocks send", () => {
    controllerMock.value.modelStatus = {
      kind: "downloading",
      blocksSend: true,
      percent: 10,
      etaMs: null,
      modelName: "Eliza 1",
      errors: [],
    };
    controllerMock.value.canSend = false;

    render(<HomeView />);
    openHomeChatPanel();

    const input = screen.getByTestId("home-chat-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });

    const sendButton = screen.getByRole("button", {
      name: "Send message",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    fireEvent.click(sendButton);
    expect(controllerMock.value.send).not.toHaveBeenCalled();
  });

  it("offers recovery affordances when the assigned model is missing", () => {
    controllerMock.value.modelStatus = {
      kind: "missing",
      blocksSend: true,
      percent: null,
      etaMs: null,
      modelName: "Eliza 1",
      errors: [],
    };
    controllerMock.value.canSend = false;

    render(<HomeView />);

    const panel = screen.getByTestId("home-model-status");
    expect(panel.getAttribute("data-kind")).toBe("missing");
    expect(screen.getByRole("button", { name: "Manage models" })).toBeTruthy();
  });

  it("surfaces the failure message when model activation errors", () => {
    controllerMock.value.modelStatus = {
      kind: "error",
      blocksSend: true,
      percent: null,
      etaMs: null,
      modelName: "Eliza 1",
      errors: ["checksum mismatch"],
    };
    controllerMock.value.canSend = false;

    render(<HomeView />);

    const panel = screen.getByTestId("home-model-status");
    expect(panel.getAttribute("data-kind")).toBe("error");
    expect(panel.textContent).toContain("checksum mismatch");
  });

  it("renders the mic as the trailing control and opens voice on a quick tap", () => {
    render(<HomeView />);
    openHomeChatPanel();

    const input = screen.getByTestId("home-chat-input");
    const mic = screen.getByRole("button", { name: "Start voice input" });
    // The mic is a visual icon control that trails the text input in DOM order.
    expect(mic.querySelector("svg")).not.toBeNull();
    expect(
      input.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // A quick (keyboard/synthetic) tap toggles open-voice capture — it must not
    // start a push-to-talk session.
    fireEvent.click(mic);
    expect(controllerMock.value.toggleRecording).toHaveBeenCalledTimes(1);
    expect(controllerMock.value.startRecording).not.toHaveBeenCalled();
  });

  it("push-to-talk records for the duration of the hold", () => {
    vi.useFakeTimers();
    try {
      render(<HomeView />);
      openHomeChatPanel();
      const mic = screen.getByRole("button", { name: "Start voice input" });

      fireEvent.pointerDown(mic, { pointerId: 1, button: 0 });
      // Held past the push-to-talk threshold (200ms) → capture begins.
      vi.advanceTimersByTime(300);
      expect(controllerMock.value.startRecording).toHaveBeenCalledTimes(1);

      fireEvent.pointerUp(mic, { pointerId: 1, button: 0 });
      // Release ends capture and must not also fire an open-voice toggle.
      expect(controllerMock.value.stopRecording).toHaveBeenCalledTimes(1);
      expect(controllerMock.value.toggleRecording).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("morphs the mic into a send button once the user types", () => {
    render(<HomeView />);
    openHomeChatPanel();

    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();

    const input = screen.getByTestId("home-chat-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });

    // The mic is replaced by send; there is a single morphing trailing control.
    expect(
      screen.queryByRole("button", { name: "Start voice input" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });
});
