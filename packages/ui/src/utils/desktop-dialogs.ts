import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";

type DesktopDialogType = "none" | "info" | "error" | "question" | "warning";

type DesktopAlertOptions = {
  title: string;
  message: string;
  detail?: string;
  type?: Exclude<DesktopDialogType, "question">;
};

type DesktopConfirmOptions = {
  title: string;
  message: string;
  detail?: string;
  type?: Extract<DesktopDialogType, "question" | "warning">;
  confirmLabel?: string;
  cancelLabel?: string;
};

function formatFallbackDialogText(options: {
  title: string;
  message: string;
  detail?: string;
}) {
  return [options.title, options.message, options.detail]
    .filter(Boolean)
    .join("\n\n");
}

function coerceButtonIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number.parseInt(value.trim(), 10);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

/**
 * Parses `desktopShowMessageBox` RPC result. Electrobun may return `{ response: 0 }`
 * or a bare `0` — the latter is falsy in JS, so never use `if (response)` on the payload.
 * Also unwraps one-level `{ data: … }` / `{ result: … }` envelopes from RPC layers.
 */
function parseMessageBoxButtonIndex(payload: unknown): number | null {
  if (payload === null || payload === undefined) return null;

  if (typeof payload === "object" && payload !== null) {
    const o = payload as Record<string, unknown>;
    if ("data" in o) {
      const inner = parseMessageBoxButtonIndex(o.data);
      if (inner !== null) return inner;
    }
    if ("result" in o) {
      const inner = parseMessageBoxButtonIndex(o.result);
      if (inner !== null) return inner;
    }
    if ("payload" in o) {
      const inner = parseMessageBoxButtonIndex(o.payload);
      if (inner !== null) return inner;
    }
  }

  const direct = coerceButtonIndex(payload);
  if (direct !== null) return direct;

  if (
    typeof payload === "object" &&
    payload !== null &&
    "response" in payload
  ) {
    return coerceButtonIndex((payload as { response: unknown }).response);
  }
  return null;
}

/** WKWebView often needs more than one turn before `fetch` runs after a native sheet closes. */
async function yieldWebviewAfterNativeDialog(): Promise<void> {
  if (typeof window === "undefined") return;
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    queueMicrotask(() => resolve());
  });
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 0);
  });
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    window.setTimeout(finish, 100);
    window.requestAnimationFrame(finish);
  });
}

/**
 * Extra scheduling slack after native message boxes so Electroview RPC and
 * `fetch` reliably run (see `handleReset` / cloud disconnect).
 */
export async function yieldHttpAfterNativeMessageBox(): Promise<void> {
  if (typeof window === "undefined") return;
  await yieldWebviewAfterNativeDialog();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    window.setTimeout(finish, 100);
    window.requestAnimationFrame(finish);
  });
  await new Promise<void>((resolve) => {
    window.setTimeout(() => resolve(), 50);
  });
}

export async function confirmDesktopAction(
  options: DesktopConfirmOptions,
): Promise<boolean> {
  const payload = await invokeDesktopBridgeRequest<unknown>({
    rpcMethod: "desktopShowMessageBox",
    ipcChannel: "desktop:showMessageBox",
    params: {
      type: options.type ?? "question",
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: [
        options.confirmLabel ?? "Confirm",
        options.cancelLabel ?? "Cancel",
      ],
      defaultId: 0,
      cancelId: 1,
    },
  });

  const usedNativeBridge = payload !== null && payload !== undefined;
  const idx = parseMessageBoxButtonIndex(payload);

  let confirmed: boolean;
  if (usedNativeBridge && idx !== null) {
    confirmed = idx === 0;
  } else if (usedNativeBridge) {
    if (typeof window === "undefined") {
      confirmed = false;
    } else {
      confirmed = window.confirm(formatFallbackDialogText(options));
    }
  } else if (typeof window === "undefined") {
    return false;
  } else {
    confirmed = window.confirm(formatFallbackDialogText(options));
  }

  // Native sheet can return without letting the webview run `fetch` on the same turn
  // (same as handleReset). Yield once after a confirmed native dialog.
  if (confirmed && usedNativeBridge && isElectrobunRuntime()) {
    await yieldWebviewAfterNativeDialog();
  }

  return confirmed;
}

export async function alertDesktopMessage(
  options: DesktopAlertOptions,
): Promise<void> {
  const payload = await invokeDesktopBridgeRequest<unknown>({
    rpcMethod: "desktopShowMessageBox",
    ipcChannel: "desktop:showMessageBox",
    params: {
      type: options.type ?? "info",
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
    },
  });

  if (payload !== null && payload !== undefined) return;

  if (typeof window === "undefined") return;
  window.alert(formatFallbackDialogText(options));
}
