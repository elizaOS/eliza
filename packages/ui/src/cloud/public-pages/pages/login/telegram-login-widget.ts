import type { StewardTelegramLoginPayload } from "@stwd/sdk";

const TELEGRAM_WIDGET_SRC = "https://telegram.org/js/telegram-widget.js?22";
const TELEGRAM_WIDGET_TIMEOUT_MS = 15_000;
const TELEGRAM_WIDGET_MARKER = "data-eliza-telegram-login-widget";

type TelegramLoginAuth = (
  options: { bot_id: string; request_access: "write" },
  callback: (payload: StewardTelegramLoginPayload | false) => void,
) => void;

declare global {
  interface Window {
    Telegram?: {
      Login?: {
        auth?: TelegramLoginAuth;
      };
    };
  }
}

export class TelegramLoginCancelledError extends Error {
  constructor() {
    super("Telegram sign-in was cancelled.");
    this.name = "TelegramLoginCancelledError";
  }
}

let widgetLoadPromise: Promise<TelegramLoginAuth> | null = null;

export function getConfiguredTelegramBotId(
  configured = import.meta.env.VITE_TELEGRAM_BOT_ID,
): string | null {
  const botId = configured?.trim();
  return botId && /^\d+$/.test(botId) ? botId : null;
}

function configuredTelegramBotUsername(): string | null {
  const username = import.meta.env.VITE_TELEGRAM_BOT_USERNAME?.trim();
  return username && /^[A-Za-z0-9_]+$/.test(username) ? username : null;
}

function readTelegramLoginAuth(): TelegramLoginAuth | null {
  const login = window.Telegram?.Login;
  const auth = login?.auth;
  return typeof auth === "function" ? auth.bind(login) : null;
}

function loadTelegramLoginWidget(): Promise<TelegramLoginAuth> {
  const ready = readTelegramLoginAuth();
  if (ready) return Promise.resolve(ready);
  if (widgetLoadPromise) return widgetLoadPromise;

  widgetLoadPromise = new Promise<TelegramLoginAuth>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[${TELEGRAM_WIDGET_MARKER}]`,
    );
    const script = existing ?? document.createElement("script");
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    };
    const onLoad = () => {
      const auth = readTelegramLoginAuth();
      if (!auth) {
        finish();
        widgetLoadPromise = null;
        reject(
          new Error(
            "Telegram sign-in did not initialize. Check content blockers and try again.",
          ),
        );
        return;
      }
      finish();
      resolve(auth);
    };
    const onError = () => {
      finish();
      widgetLoadPromise = null;
      reject(
        new Error(
          "Telegram sign-in could not load. Check your connection or content blocker and try again.",
        ),
      );
    };

    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    timeout = setTimeout(() => {
      finish();
      widgetLoadPromise = null;
      reject(
        new Error(
          "Telegram sign-in took too long to load. Check your connection or content blocker and try again.",
        ),
      );
    }, TELEGRAM_WIDGET_TIMEOUT_MS);

    if (!existing) {
      script.src = TELEGRAM_WIDGET_SRC;
      script.async = true;
      script.setAttribute(TELEGRAM_WIDGET_MARKER, "true");
      script.setAttribute("data-request-access", "write");
      const username = configuredTelegramBotUsername();
      if (username) script.setAttribute("data-telegram-login", username);

      const hiddenContainer = document.createElement("div");
      hiddenContainer.hidden = true;
      hiddenContainer.setAttribute("aria-hidden", "true");
      hiddenContainer.appendChild(script);
      document.body.appendChild(hiddenContainer);
    }
  });

  return widgetLoadPromise;
}

export async function requestTelegramLogin(
  botId: string,
): Promise<StewardTelegramLoginPayload> {
  if (!/^\d+$/.test(botId)) {
    throw new Error("Telegram sign-in is not configured for this app.");
  }
  const auth = await loadTelegramLoginWidget();
  return new Promise<StewardTelegramLoginPayload>((resolve, reject) => {
    try {
      auth({ bot_id: botId, request_access: "write" }, (payload) => {
        if (!payload) {
          reject(new TelegramLoginCancelledError());
          return;
        }
        resolve(payload);
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** Test helper: reset only module-owned loader state, never window auth state. */
export function resetTelegramWidgetLoaderForTests(): void {
  widgetLoadPromise = null;
}
