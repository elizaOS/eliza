// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getConfiguredTelegramBotId,
  requestTelegramLogin,
  resetTelegramWidgetLoaderForTests,
  TelegramLoginCancelledError,
} from "./telegram-login-widget";

function removeWidget(): void {
  document
    .querySelector("script[data-eliza-telegram-login-widget]")
    ?.parentElement?.remove();
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.Telegram;
  removeWidget();
  resetTelegramWidgetLoaderForTests();
});

describe("Telegram login widget", () => {
  it("accepts only a numeric configured bot id", () => {
    expect(getConfiguredTelegramBotId(" 7684336618 ")).toBe("7684336618");
    expect(getConfiguredTelegramBotId("@Elizav2_Bot")).toBeNull();
    expect(getConfiguredTelegramBotId("")).toBeNull();
  });

  it("loads on user intent and returns the signed Telegram payload", async () => {
    const auth = vi.fn(
      (
        _options: { bot_id: string; request_access: "write" },
        callback: (payload: {
          id: number;
          first_name: string;
          auth_date: number;
          hash: string;
        }) => void,
      ) =>
        callback({
          id: 42,
          first_name: "Eliza",
          auth_date: 1_787_000_000,
          hash: "signed-payload",
        }),
    );

    const result = requestTelegramLogin("7684336618");
    const script = document.querySelector<HTMLScriptElement>(
      "script[data-eliza-telegram-login-widget]",
    );
    expect(script?.src).toBe("https://telegram.org/js/telegram-widget.js?22");
    window.Telegram = { Login: { auth } };
    script?.dispatchEvent(new Event("load"));

    await expect(result).resolves.toMatchObject({
      id: 42,
      hash: "signed-payload",
    });
    expect(auth).toHaveBeenCalledWith(
      { bot_id: "7684336618", request_access: "write" },
      expect.any(Function),
    );
  });

  it("distinguishes user cancellation from a provider failure", async () => {
    window.Telegram = {
      Login: { auth: (_options, callback) => callback(false) },
    };

    await expect(requestTelegramLogin("7684336618")).rejects.toBeInstanceOf(
      TelegramLoginCancelledError,
    );
  });

  it("reports a widget that loads without initializing auth", async () => {
    const result = requestTelegramLogin("7684336618");
    document
      .querySelector<HTMLScriptElement>(
        "script[data-eliza-telegram-login-widget]",
      )
      ?.dispatchEvent(new Event("load"));

    await expect(result).rejects.toThrow(/did not initialize/i);
  });
});
