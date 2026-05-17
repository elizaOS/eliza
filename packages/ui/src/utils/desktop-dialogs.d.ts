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
/**
 * Extra scheduling slack after native message boxes so Electroview RPC and
 * `fetch` reliably run (see `handleReset` / cloud disconnect).
 */
export declare function yieldHttpAfterNativeMessageBox(): Promise<void>;
export declare function confirmDesktopAction(
  options: DesktopConfirmOptions,
): Promise<boolean>;
export declare function alertDesktopMessage(
  options: DesktopAlertOptions,
): Promise<void>;
//# sourceMappingURL=desktop-dialogs.d.ts.map
