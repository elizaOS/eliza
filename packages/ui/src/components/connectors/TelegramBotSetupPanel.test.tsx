/** Exercises bot disconnect receipts and pending/error presentation with synthetic API responses. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../api", () => ({ client: api }));
vi.mock("../../state", () => ({
  useAppSelector: (
    select: (state: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => unknown,
  ) => select({ t: (key, options) => options?.defaultValue ?? key }),
}));

import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";

afterEach(cleanup);
beforeEach(() => api.fetch.mockReset());

async function connectedPanel() {
  api.fetch.mockResolvedValueOnce({
    connector: "telegram",
    state: "idle",
    detail: { hasToken: false },
  });
  api.fetch.mockResolvedValueOnce({
    connector: "telegram",
    state: "configuring",
    detail: {
      bot: { id: 123456, username: "synthetic_bot", firstName: "Synthetic" },
    },
  });
  render(<TelegramBotSetupPanel />);
  await waitFor(() =>
    expect(screen.queryByText("Checking Telegram…")).toBeNull(),
  );
  fireEvent.change(
    screen.getByPlaceholderText("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"),
    {
      target: { value: "123456:synthetic-token" },
    },
  );
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("@synthetic_bot");
}

describe("Telegram bot disconnect", () => {
  it("keeps identity while pending and only clears after a terminal receipt", async () => {
    await connectedPanel();
    let finish!: (value: unknown) => void;
    api.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Disconnecting…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("@synthetic_bot")).toBeTruthy();
    finish({
      connector: "telegram",
      state: "disconnected",
      accountId: "default",
      credentialRetained: false,
    });
    await screen.findByRole("status");
    expect(screen.queryByText("@synthetic_bot")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Bot disconnected.",
    );
    expect(api.fetch).toHaveBeenLastCalledWith(
      "/api/setup/telegram/disconnect",
      { method: "POST", body: JSON.stringify({ expectedBotId: 123456 }) },
    );
  });

  it("sends the displayed identity and preserves it when the server rejects a replacement", async () => {
    await connectedPanel();
    api.fetch.mockRejectedValueOnce(
      new Error("The connected bot changed. Refresh before disconnecting."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "connected bot changed",
    );
    expect(screen.getByText("@synthetic_bot")).toBeTruthy();
    expect(api.fetch).toHaveBeenLastCalledWith(
      "/api/setup/telegram/disconnect",
      {
        method: "POST",
        body: JSON.stringify({ expectedBotId: 123456 }),
      },
    );
  });

  it("restores an unfinished disconnect after remount and retries the same bot", async () => {
    const pending = {
      connector: "telegram",
      state: "configuring",
      detail: {
        bot: { id: 123456, username: "synthetic_bot", firstName: "Synthetic" },
        disconnectPending: true,
        hasToken: false,
      },
    };
    api.fetch.mockResolvedValueOnce(pending);
    const view = render(<TelegramBotSetupPanel />);
    await screen.findByText(/^Disconnect incomplete/);
    view.unmount();
    api.fetch.mockResolvedValueOnce(pending);
    render(<TelegramBotSetupPanel />);
    const retry = await screen.findByRole("button", {
      name: "Retry disconnect",
    });
    api.fetch.mockResolvedValueOnce({
      connector: "telegram",
      state: "disconnected",
      accountId: "default",
    });
    fireEvent.click(retry);
    await screen.findByText("Bot disconnected.");
    expect(api.fetch).toHaveBeenLastCalledWith(
      "/api/setup/telegram/disconnect",
      { method: "POST", body: JSON.stringify({ expectedBotId: 123456 }) },
    );
  });

  it("restores retained cleanup separately from connection state", async () => {
    api.fetch.mockResolvedValueOnce({
      connector: "telegram",
      state: "idle",
      detail: {
        bot: { id: 123456, username: "synthetic_bot", firstName: "Synthetic" },
        credentialRetained: true,
        hasToken: false,
      },
    });
    render(<TelegramBotSetupPanel />);
    const retry = await screen.findByRole("button", { name: "Retry cleanup" });
    expect(screen.getByText(/^Disconnected · cleanup needed/)).toBeTruthy();
    api.fetch.mockResolvedValueOnce({
      connector: "telegram",
      state: "disconnected",
      accountId: "default",
      credentialRetained: false,
    });
    fireEvent.click(retry);
    await screen.findByText("Bot disconnected.");
  });

  it("requires revalidation for legacy missing identity and retries failed status reads", async () => {
    api.fetch.mockRejectedValueOnce(new Error("Status unavailable"));
    render(<TelegramBotSetupPanel />);
    const retry = await screen.findByRole("button", { name: "Retry status" });
    api.fetch.mockResolvedValueOnce({
      connector: "telegram",
      state: "paired",
      detail: { hasToken: true },
    });
    fireEvent.click(retry);
    await screen.findByText(
      "Bot identity unavailable. Revalidate the token before changing this connection.",
    );
    expect(screen.queryByText("Telegram connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("blocks Enter during pending or failed status and admits only one validation", async () => {
    let rejectStatus!: (error: Error) => void;
    api.fetch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStatus = reject;
        }),
    );
    render(<TelegramBotSetupPanel />);
    const input = screen.getByPlaceholderText(
      "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    );
    fireEvent.change(input, { target: { value: "123456:synthetic-token" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/setup/telegram/status",
    ]);
    rejectStatus(new Error("Status unavailable"));
    await screen.findByRole("button", { name: "Retry status" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.fetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/setup/telegram/status",
    ]);
    api.fetch.mockResolvedValueOnce({
      connector: "telegram",
      state: "idle",
      detail: { hasToken: false },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    let finish!: (value: unknown) => void;
    api.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      api.fetch.mock.calls.filter(
        ([path]) => path === "/api/setup/telegram/start",
      ),
    ).toHaveLength(1);
    finish({
      connector: "telegram",
      state: "configuring",
      detail: {
        bot: { id: 123456, username: "synthetic_bot", firstName: "Synthetic" },
      },
    });
    await screen.findByText("@synthetic_bot");
  });

  it("rejects an unconfirmed receipt and permits retry without losing identity", async () => {
    await connectedPanel();
    api.fetch.mockResolvedValueOnce({ connector: "telegram", state: "idle" });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByRole("alert");
    expect(screen.getByText("@synthetic_bot")).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Disconnect",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    api.fetch.mockResolvedValueOnce({
      connector: "telegram",
      state: "disconnected",
      accountId: "default",
    });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Bot disconnected.");
  });
});
