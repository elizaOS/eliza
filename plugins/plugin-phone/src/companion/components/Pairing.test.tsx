// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pairing } from "./Pairing";

const elizaIntent = vi.hoisted(() => ({
  setPairingStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../services", async () => {
  const actual =
    await vi.importActual<typeof import("../services")>("../services");
  return {
    ...actual,
    ElizaIntent: elizaIntent,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("Pairing", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("pairs from a pasted full pairing payload", async () => {
    const payload = {
      agentId: "agent-1",
      pairingCode: "code-1",
      ingressUrl: "wss://relay.example/input",
      sessionToken: "token-1",
    };
    const onPaired = vi.fn();

    render(<Pairing onPaired={onPaired} onBack={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Or paste payload"), {
      target: { value: encodePayload(payload) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledWith(payload));
    expect(elizaIntent.setPairingStatus).toHaveBeenCalledWith({
      deviceId: payload.agentId,
      agentUrl: payload.ingressUrl,
    });
  });

  it("shows a validation error and does not pair on a blank submit", async () => {
    const onPaired = vi.fn();
    render(<Pairing onPaired={onPaired} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    await screen.findByText("Paste the pairing payload shown on your Mac.");
    expect(onPaired).not.toHaveBeenCalled();
    expect(elizaIntent.setPairingStatus).not.toHaveBeenCalled();
  });

  it("surfaces the decode error and does not pair on a malformed payload", async () => {
    const onPaired = vi.fn();
    render(<Pairing onPaired={onPaired} onBack={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Or paste payload"), {
      target: { value: "%%% not base64 %%%" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    // The decode throw message bubbles into the error <p> (distinct from the
    // always-present hint <p>): after submit there are two paragraphs.
    await waitFor(() => {
      const paragraphs = Array.from(document.querySelectorAll("p"));
      const hint =
        "Scan the QR code shown in the Eliza desktop app, or paste its pairing payload manually.";
      const errorP = paragraphs.find((p) => p.textContent?.trim() !== hint);
      expect(errorP?.textContent && errorP.textContent.length > 0).toBe(true);
    });
    expect(onPaired).not.toHaveBeenCalled();
    expect(elizaIntent.setPairingStatus).not.toHaveBeenCalled();
  });

  it("calls onBack from the Back button", () => {
    const onBack = vi.fn();
    render(<Pairing onPaired={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows the native-only error when Scan QR is pressed on web", async () => {
    // Under jsdom, Capacitor.isNativePlatform() is false (web), so the scan
    // handler hits the web fallback branch.
    render(<Pairing onPaired={vi.fn()} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan QR code" }));
    await screen.findByText(
      "Camera scan requires the iOS native runtime. Paste the code below.",
    );
  });
});
