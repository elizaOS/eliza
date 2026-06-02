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
});
