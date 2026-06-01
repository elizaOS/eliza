// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstRunShell, type FirstRunShellProps } from "../FirstRunShell";

function props(
  overrides: Partial<FirstRunShellProps> = {},
): FirstRunShellProps {
  return {
    step: "runtime",
    draft: {
      agentName: "Eliza",
      runtime: "cloud",
      localInference: "all-local",
      remoteApiBase: "",
      remoteToken: "",
    },
    localRuntimeAvailable: true,
    cloudOnly: false,
    elizaCloudConnected: false,
    submitting: false,
    busyText: null,
    error: null,
    cloudError: null,
    voice: {
      supported: true,
      listening: false,
      speaking: false,
      transcript: "",
      error: null,
    },
    microphone: {
      status: "granted",
      canRequest: true,
      requesting: false,
      request: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
    },
    primaryLabel: "Continue",
    canBack: false,
    updateDraft: vi.fn(),
    setStep: vi.fn(),
    goBack: vi.fn(),
    finishRuntime: vi.fn(),
    toggleVoice: vi.fn(async () => {}),
    onPromptReady: vi.fn(),
    ...overrides,
  };
}

async function revealPrompt(): Promise<void> {
  await act(async () => {
    vi.runAllTimers();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("FirstRunShell", () => {
  it("shows an idle voice status badge with a muted-mic icon", async () => {
    vi.useFakeTimers();
    const toggleVoice = vi.fn(async () => {});
    render(<FirstRunShell {...props({ toggleVoice })} />);

    await revealPrompt();

    const voiceToggle = screen.getByRole("button", {
      name: "Start voice input",
    });
    expect(voiceToggle.textContent).toBe("Not listening");
    // Idle state renders a muted-mic glyph, not bare text.
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
    expect(voiceToggle.className).toContain("bg-transparent");

    fireEvent.click(voiceToggle);

    expect(toggleVoice).toHaveBeenCalledTimes(1);
  });

  it("stacks Cloud (recommended), Local (advanced), and Remote cards", async () => {
    vi.useFakeTimers();
    render(<FirstRunShell {...props()} />);
    await revealPrompt();

    const cloud = screen.getByTestId("first-run-runtime-cloud");
    const local = screen.getByTestId("first-run-runtime-local");
    const remote = screen.getByTestId("first-run-runtime-remote");

    expect(cloud.textContent).toContain("Recommended");
    expect(cloud.textContent).toContain("never sleep");
    expect(local.textContent).toContain("Advanced");
    expect(remote.textContent).toContain("Use as remote");

    // Stacked top-to-bottom: Cloud, then Local, then Remote at the bottom.
    expect(
      cloud.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      local.compareDocumentPosition(remote) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the Local card when the platform cannot run a local agent", async () => {
    vi.useFakeTimers();
    render(<FirstRunShell {...props({ localRuntimeAvailable: false })} />);
    await revealPrompt();

    expect(screen.getByTestId("first-run-runtime-cloud")).toBeTruthy();
    expect(screen.getByTestId("first-run-runtime-remote")).toBeTruthy();
    expect(screen.queryByTestId("first-run-runtime-local")).toBeNull();
  });

  it("shows only the Cloud card in cloud-only mode (hides Local and Remote)", async () => {
    vi.useFakeTimers();
    render(
      <FirstRunShell
        {...props({ cloudOnly: true, localRuntimeAvailable: false })}
      />,
    );
    await revealPrompt();

    expect(screen.getByTestId("first-run-runtime-cloud")).toBeTruthy();
    expect(screen.queryByTestId("first-run-runtime-local")).toBeNull();
    expect(screen.queryByTestId("first-run-runtime-remote")).toBeNull();
  });

  it("does not render the remote form from a stale remote step in cloud-only mode", async () => {
    vi.useFakeTimers();
    render(<FirstRunShell {...props({ cloudOnly: true, step: "remote" })} />);
    await revealPrompt();

    expect(screen.getByTestId("first-run-runtime-cloud")).toBeTruthy();
    expect(
      screen.queryByPlaceholderText("https://agent.example.com"),
    ).toBeNull();
    expect(screen.queryByTestId("first-run-runtime-remote")).toBeNull();
  });

  it("exposes the local inference sub-choice only when Local is selected", async () => {
    vi.useFakeTimers();
    const updateDraft = vi.fn();
    const { rerender } = render(<FirstRunShell {...props({ updateDraft })} />);
    await revealPrompt();

    expect(screen.queryByTestId("first-run-local-all-local")).toBeNull();

    rerender(
      <FirstRunShell
        {...props({
          updateDraft,
          draft: {
            agentName: "Eliza",
            runtime: "local",
            localInference: "all-local",
            remoteApiBase: "",
            remoteToken: "",
          },
        })}
      />,
    );

    expect(screen.getByTestId("first-run-local-all-local")).toBeTruthy();
    fireEvent.click(screen.getByTestId("first-run-local-cloud-inference"));
    expect(updateDraft).toHaveBeenCalledWith(
      "localInference",
      "cloud-inference",
    );
  });

  it("fires onPromptReady once per prompt even when its identity changes every render", async () => {
    // Regression guard for the onboarding freeze: the prompt-ready effect used
    // to depend on the `onPromptReady` identity. That handler ultimately derives
    // from app-context callbacks whose identity flips while first-run state
    // churns during agent start, so the effect re-fired on every render → the
    // handler's setVoice re-rendered → infinite loop that froze onboarding.
    // The effect now keys on the prompt text/completion only, called through a
    // ref, so a fresh handler identity per render must NOT re-fire it.
    vi.useFakeTimers();
    let calls = 0;
    // Stable base props so the only thing changing across rerenders is the
    // `onPromptReady` identity — exactly the churn the freeze came from.
    const base = props();
    const render1 = (handler: FirstRunShellProps["onPromptReady"]) => (
      <FirstRunShell {...base} onPromptReady={handler} />
    );
    const { rerender } = render(render1(() => void calls++));
    await revealPrompt();

    // Baseline fire count once the typed prompt has settled. The invariant we
    // guard is the *delta*: swapping the handler identity must add zero fires.
    const baseline = calls;
    for (let i = 0; i < 20; i++) {
      // Fresh handler identity every render; nothing else changes.
      rerender(render1(() => void calls++));
      await act(async () => {
        vi.runAllTimers();
      });
    }

    // The effect keys on prompt text/completion, not the handler identity, so
    // swapping the handler 20x must not re-fire it.
    expect(calls).toBe(baseline);
  });

  it("changes the voice status badge to listening when capture is active", async () => {
    vi.useFakeTimers();
    render(
      <FirstRunShell
        {...props({
          voice: {
            supported: true,
            listening: true,
            speaking: false,
            transcript: "",
            error: null,
          },
        })}
      />,
    );

    await revealPrompt();

    const voiceToggle = screen.getByRole("button", {
      name: "Stop voice input",
    });
    expect(voiceToggle.textContent).toBe("Listening");
    expect(voiceToggle.getAttribute("aria-pressed")).toBe("true");
    expect(voiceToggle.querySelector("svg")).toBeNull();
    expect(voiceToggle.className).toContain("bg-transparent");
  });

  it("requests microphone access when permission is not yet determined", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => {});
    render(
      <FirstRunShell
        {...props({
          microphone: {
            status: "not-determined",
            canRequest: true,
            requesting: false,
            request,
            openSettings: vi.fn(async () => {}),
          },
        })}
      />,
    );
    await revealPrompt();

    const enable = screen.getByTestId("first-run-microphone-request");
    expect(enable.textContent).toContain("Enable microphone");
    fireEvent.click(enable);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("offers Open Settings when microphone access is denied", async () => {
    vi.useFakeTimers();
    const openSettings = vi.fn(async () => {});
    render(
      <FirstRunShell
        {...props({
          microphone: {
            status: "denied",
            canRequest: false,
            requesting: false,
            request: vi.fn(async () => {}),
            openSettings,
          },
        })}
      />,
    );
    await revealPrompt();

    expect(screen.queryByTestId("first-run-microphone-request")).toBeNull();
    const settings = screen.getByTestId("first-run-microphone-open-settings");
    expect(settings.textContent).toContain("Open Settings");
    fireEvent.click(settings);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("shows a ready badge and no buttons once microphone is granted", async () => {
    vi.useFakeTimers();
    render(<FirstRunShell {...props()} />);
    await revealPrompt();

    expect(screen.getByText("Microphone ready")).toBeTruthy();
    expect(screen.queryByTestId("first-run-microphone-request")).toBeNull();
    expect(
      screen.queryByTestId("first-run-microphone-open-settings"),
    ).toBeNull();
  });
});
