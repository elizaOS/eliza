// @vitest-environment jsdom

/**
 * Drives the Pairing view in jsdom over a mocked ElizaIntent bridge: exercises
 * the paste-the-code path, payload decode, and the onPaired handoff.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pairing } from "./Pairing";

const platform = vi.hoisted(() => ({ native: true, name: "ios" }));
const elizaIntent = vi.hoisted(() => ({
  setPairingStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@capacitor/core", async () => {
  const actual =
    await vi.importActual<typeof import("@capacitor/core")>("@capacitor/core");
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => platform.native,
      getPlatform: () => platform.name,
    },
  };
});

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
    platform.native = true;
    platform.name = "ios";
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

    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: encodePayload(payload) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledWith(payload));
    expect(elizaIntent.setPairingStatus).toHaveBeenCalledWith({
      deviceId: payload.agentId,
      agentUrl: payload.ingressUrl,
    });
  });

  it("shows a validation error and does not pair on a blank submit", async () => {
    const onPaired = vi.fn();
    render(<Pairing onPaired={onPaired} onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Pair" }));

    await screen.findByText("Paste a pairing code first.");
    expect(onPaired).not.toHaveBeenCalled();
    expect(elizaIntent.setPairingStatus).not.toHaveBeenCalled();
  });

  it("surfaces the decode error and does not pair on a malformed payload", async () => {
    const onPaired = vi.fn();
    render(<Pairing onPaired={onPaired} onBack={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: "%%% not base64 %%%" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));

    // The decode throw message bubbles into the error <p> (distinct from the
    // always-present hint <p>): after submit there are two paragraphs.
    await waitFor(() => {
      const paragraphs = Array.from(document.querySelectorAll("p"));
      const hint = "Scan the code on your computer or paste it below.";
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

  it("does not expose pairing controls outside native iOS", async () => {
    platform.native = false;
    platform.name = "web";
    render(<Pairing onPaired={vi.fn()} onBack={vi.fn()} />);
    await screen.findByText("Phone pairing is available in the Eliza iOS app.");
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
  });
});
