/**
 * Component coverage for Telegram bot onboarding and its visible disconnect
 * recovery path. The API client is local-only mocked; no token is validated
 * and no Telegram network request or outbound message is made.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  value: {
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  },
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appMock.value) => unknown) =>
    selector(appMock.value),
}));

vi.mock("../../api", () => ({
  client: {
    fetch: vi.fn(),
  },
}));

import { client } from "../../api";
import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";

describe("TelegramBotSetupPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a failed disconnect visible and preserves the connected identity", async () => {
    const fetchMock = client.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce({
      connector: "telegram",
      state: "paired",
      detail: {
        bot: { id: 123, username: "eliza_test_bot", firstName: "Eliza" },
      },
    });

    render(<TelegramBotSetupPanel />);

    expect(screen.getByTestId("telegram-group-guide").textContent).toContain(
      "BotFather privacy",
    );

    fireEvent.change(screen.getByPlaceholderText(/123456:ABC/), {
      target: { value: "test-token-not-sent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(screen.getByText("@eliza_test_bot")).toBeTruthy();
    });

    fetchMock.mockRejectedValueOnce(
      new Error("Telegram disconnect unavailable"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() => {
      expect(screen.getByText("Telegram disconnect unavailable")).toBeTruthy();
    });
    expect(screen.getByText("@eliza_test_bot")).toBeTruthy();
  });
});
