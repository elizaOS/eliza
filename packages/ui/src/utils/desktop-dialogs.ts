/**
 * Alert/confirm helpers backed by the browser's `window.alert` and
 * `window.confirm`.
 */

type DesktopAlertOptions = {
  title: string;
  message: string;
  detail?: string;
  type?: "none" | "info" | "error" | "warning";
};

type DesktopConfirmOptions = {
  title: string;
  message: string;
  detail?: string;
  type?: "question" | "warning";
  confirmLabel?: string;
  cancelLabel?: string;
};

function formatDialogText(options: {
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
  if (typeof window === "undefined") return false;
  return window.confirm(formatDialogText(options));
}

export async function alertDesktopMessage(
  options: DesktopAlertOptions,
): Promise<void> {
  if (typeof window === "undefined") return;
  window.alert(formatDialogText(options));
}
