import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

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

export async function confirmDesktopAction(
  options: DesktopConfirmOptions,
): Promise<boolean> {
  const response = await invokeDesktopBridgeRequest<{ response?: number }>({
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

  if (response) {
    return response.response === 0;
  }

  if (typeof window === "undefined") return false;
  return window.confirm(formatFallbackDialogText(options));
}

export async function alertDesktopMessage(
  options: DesktopAlertOptions,
): Promise<void> {
  const response = await invokeDesktopBridgeRequest<{ response?: number }>({
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

  if (response) return;

  if (typeof window === "undefined") return;
  window.alert(formatFallbackDialogText(options));
}
