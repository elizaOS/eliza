/**
 * Lazily mounts Telegram's official login widget and translates its untrusted
 * browser callback into the narrow payload Steward verifies server-side.
 */

import type { StewardTelegramLoginPayload } from "@stwd/sdk";
import { useEffect, useRef, useState } from "react";

const TELEGRAM_WIDGET_SCRIPT = "https://telegram.org/js/telegram-widget.js?22";
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z0-9_]{5,32}$/;
const TELEGRAM_HASH_PATTERN = /^[A-Fa-f0-9]{64}$/;
const TELEGRAM_DECIMAL_ID_PATTERN = /^[1-9]\d{0,19}$/;
const TELEGRAM_WIDGET_LOAD_TIMEOUT_MS = 15_000;

let callbackSequence = 0;

type TelegramCallbackWindow = Window &
  Record<string, ((value: unknown) => void) | undefined>;

/** Reject malformed widget messages before they reach the Steward SDK. */
export function parseTelegramLoginPayload(
  value: unknown,
): StewardTelegramLoginPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(record);
  } catch {
    return null;
  }
  if (entries.length === 0 || entries.length > 32) return null;
  const payload = Object.create(null) as StewardTelegramLoginPayload;
  for (const [key, field] of entries) {
    if (
      key.length === 0 ||
      key.length > 64 ||
      (typeof field !== "string" &&
        typeof field !== "number" &&
        typeof field !== "boolean" &&
        field !== null &&
        field !== undefined) ||
      (typeof field === "number" && !Number.isFinite(field)) ||
      (typeof field === "string" && field.length > 4_096)
    ) {
      return null;
    }
    payload[key] = field;
  }
  const id = payload.id;
  const authDate = payload.auth_date;
  const hash = payload.hash;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    (typeof authDate !== "number" && typeof authDate !== "string") ||
    typeof hash !== "string" ||
    !TELEGRAM_HASH_PATTERN.test(hash)
  ) {
    return null;
  }
  if (
    (typeof id === "number" && (!Number.isSafeInteger(id) || id <= 0)) ||
    (typeof id === "string" && !TELEGRAM_DECIMAL_ID_PATTERN.test(id)) ||
    (typeof authDate === "number" &&
      (!Number.isSafeInteger(authDate) || authDate <= 0)) ||
    (typeof authDate === "string" &&
      !TELEGRAM_DECIMAL_ID_PATTERN.test(authDate))
  ) {
    return null;
  }

  return payload;
}

export function isValidTelegramBotUsername(value: string): boolean {
  return TELEGRAM_USERNAME_PATTERN.test(value);
}

/** Resolve the deployment's public bot username without a production fallback. */
export function configuredTelegramBotUsername(): string | undefined {
  const value = import.meta.env?.VITE_TELEGRAM_BOT_USERNAME?.trim();
  return value && isValidTelegramBotUsername(value) ? value : undefined;
}

interface TelegramLoginWidgetProps {
  botUsername: string;
  disabled?: boolean;
  onAuth: (payload: StewardTelegramLoginPayload) => void;
  onError: (message: string) => void;
}

export function TelegramLoginWidget({
  botUsername,
  disabled = false,
  onAuth,
  onError,
}: TelegramLoginWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onAuthRef = useRef(onAuth);
  const onErrorRef = useRef(onError);
  const [scriptFailed, setScriptFailed] = useState(false);
  const [scriptLoaded, setScriptLoaded] = useState(false);

  onAuthRef.current = onAuth;
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || disabled) return;
    if (!isValidTelegramBotUsername(botUsername)) {
      onErrorRef.current(
        "Telegram sign-in is not configured for this deployment.",
      );
      return;
    }

    callbackSequence += 1;
    const callbackName = `__elizaTelegramLogin${callbackSequence}`;
    const callbackWindow = window as unknown as TelegramCallbackWindow;
    let callbackConsumed = false;
    callbackWindow[callbackName] = (value: unknown) => {
      if (callbackConsumed) return;
      callbackConsumed = true;
      const payload = parseTelegramLoginPayload(value);
      if (!payload) {
        onErrorRef.current(
          "Telegram returned an invalid sign-in response. Try again.",
        );
        return;
      }
      onAuthRef.current(payload);
    };

    const script = document.createElement("script");
    script.src = TELEGRAM_WIDGET_SCRIPT;
    script.async = true;
    script.setAttribute("data-telegram-login", botUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-request-access", "write");
    script.setAttribute("data-userpic", "false");
    script.setAttribute("data-onauth", `${callbackName}(user)`);
    const loadTimeout = window.setTimeout(() => {
      setScriptFailed(true);
      onErrorRef.current(
        "Telegram sign-in took too long to load. Check your connection and try again.",
      );
    }, TELEGRAM_WIDGET_LOAD_TIMEOUT_MS);
    script.onload = () => {
      window.clearTimeout(loadTimeout);
      setScriptLoaded(true);
    };
    script.onerror = () => {
      window.clearTimeout(loadTimeout);
      setScriptFailed(true);
      onErrorRef.current(
        "Could not load Telegram sign-in. Check your connection and try again.",
      );
    };
    container.appendChild(script);

    return () => {
      window.clearTimeout(loadTimeout);
      // Telegram inserts a sibling iframe before this script. The container is
      // widget-owned, so clear every child; leaving the iframe behind makes a
      // retry reuse its stale callback id and silently fail.
      container.replaceChildren();
      delete callbackWindow[callbackName];
    };
  }, [botUsername, disabled]);

  return (
    <div
      ref={containerRef}
      aria-busy={!scriptFailed && !scriptLoaded && !disabled}
      className="flex min-h-touch items-center justify-center rounded-md border border-border-strong bg-bg-elevated px-4 py-3"
    >
      {!scriptFailed && !scriptLoaded && !disabled && (
        <span className="text-sm text-muted" role="status">
          Loading secure Telegram sign-in…
        </span>
      )}
    </div>
  );
}
