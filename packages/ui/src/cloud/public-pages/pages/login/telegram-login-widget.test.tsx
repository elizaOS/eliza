/** Tests the intent-mounted Telegram widget boundary with a deterministic DOM harness. */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configuredTelegramBotUsername,
  parseTelegramLoginPayload,
  TelegramLoginWidget,
} from "./telegram-login-widget";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("TelegramLoginWidget", () => {
  it("mounts only the official script and removes its global callback on cleanup", () => {
    const onAuth = vi.fn();
    const onError = vi.fn();
    const { unmount } = render(
      <TelegramLoginWidget
        botUsername="elizastagingfelibot"
        onAuth={onAuth}
        onError={onError}
      />,
    );

    const script = document.querySelector<HTMLScriptElement>(
      'script[src="https://telegram.org/js/telegram-widget.js?22"]',
    );
    expect(script).not.toBeNull();
    expect(script?.getAttribute("data-telegram-login")).toBe(
      "elizastagingfelibot",
    );
    const onAuthExpression = script?.getAttribute("data-onauth") ?? "";
    const callbackName = onAuthExpression.replace("(user)", "");
    const callback = (window as unknown as Record<string, unknown>)[
      callbackName
    ];
    expect(typeof callback).toBe("function");

    if (typeof callback === "function") {
      callback({
        id: 123456,
        auth_date: 1_789_999_999,
        hash: "a".repeat(64),
        username: "telegram_user",
        language_code: "en",
      });
      callback({
        id: 999999,
        auth_date: 1_789_999_999,
        hash: "b".repeat(64),
      });
    }
    expect(onAuth).toHaveBeenCalledWith({
      id: 123456,
      auth_date: 1_789_999_999,
      hash: "a".repeat(64),
      username: "telegram_user",
      language_code: "en",
    });
    expect(onAuth).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    unmount();
    expect(
      (window as unknown as Record<string, unknown>)[callbackName],
    ).toBeUndefined();
  });

  it("rejects malformed signed payloads", () => {
    expect(
      parseTelegramLoginPayload({
        id: "not-a-number",
        auth_date: 1,
        hash: "short",
      }),
    ).toBeNull();
    expect(
      parseTelegramLoginPayload({
        id: 123,
        auth_date: 1,
        hash: "a".repeat(64),
        nested: { smuggled: true },
      }),
    ).toBeNull();
  });

  it("removes Telegram's injected iframe before a disabled retry remount", () => {
    const props = {
      botUsername: "elizastagingfelibot",
      onAuth: vi.fn(),
      onError: vi.fn(),
    };
    const { rerender } = render(<TelegramLoginWidget {...props} />);
    const firstScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://telegram.org/js/telegram-widget.js?22"]',
    );
    if (!firstScript?.parentElement) throw new Error("widget script missing");
    const iframe = document.createElement("iframe");
    iframe.id = "telegram-login-elizastagingfelibot";
    firstScript.parentElement.insertBefore(iframe, firstScript);

    rerender(<TelegramLoginWidget {...props} disabled />);
    expect(document.getElementById(iframe.id)).toBeNull();
    expect(document.body.contains(firstScript)).toBe(false);

    rerender(<TelegramLoginWidget {...props} />);
    const secondScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://telegram.org/js/telegram-widget.js?22"]',
    );
    expect(secondScript).not.toBeNull();
    expect(secondScript).not.toBe(firstScript);
    expect(secondScript?.getAttribute("data-onauth")).not.toBe(
      firstScript.getAttribute("data-onauth"),
    );
  });

  it("accepts only a deployment-configured Telegram username", () => {
    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", " elizastagingfelibot ");
    expect(configuredTelegramBotUsername()).toBe("elizastagingfelibot");

    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", "@not-an-attribute");
    expect(configuredTelegramBotUsername()).toBeUndefined();
  });
});
