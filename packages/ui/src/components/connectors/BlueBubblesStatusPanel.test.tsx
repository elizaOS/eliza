/**
 * Panel-state regression for the canonical BlueBubbles setup contract.
 * Verifies that the inactive (404→unavailable) and connected states render
 * the designed unavailable vs connected messages, not a generic error.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  value: {
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  },
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (s: typeof appMock.value) => unknown) => selector(appMock.value),
  useAppSelectorShallow: (selector: (s: typeof appMock.value) => unknown) => selector(appMock.value),
}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual("../../api") as Record<string, unknown>;
  return {
    ...actual,
    client: {
      getBaseUrl: () => "http://localhost:3000",
      getBlueBubblesStatus: vi.fn(),
      onWsEvent: () => () => {},
    },
  };
});

import { client } from "../../api";
import { BlueBubblesStatusPanel } from "./BlueBubblesStatusPanel";

describe("BlueBubblesStatusPanel", () => {
  afterEach(() => cleanup());

  it("renders unavailable state for inactive plugin (404→unavailable)", async () => {
    const mock = client.getBlueBubblesStatus as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      available: false,
      connected: false,
      webhookPath: "/webhooks/bluebubbles",
      reason: "bluebubbles service not registered",
    });

    render(<BlueBubblesStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText("BlueBubbles is not connected yet. Save the server URL and password above, then refresh.")).toBeTruthy();
    });
    expect(screen.getByText("bluebubbles service not registered")).toBeTruthy();
  });

  it("renders connected state with webhook target", async () => {
    const mock = client.getBlueBubblesStatus as unknown as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue({
      available: true,
      connected: true,
      webhookPath: "/webhooks/bluebubbles",
    });

    render(<BlueBubblesStatusPanel />);

    await waitFor(() => {
      expect(screen.getByText("BlueBubbles is connected.")).toBeTruthy();
    });
    expect(screen.getByText(/http:\/\/localhost:3000\/webhooks\/bluebubbles/)).toBeTruthy();
  });
});
