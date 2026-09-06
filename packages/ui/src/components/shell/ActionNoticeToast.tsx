/** Renders passive feedback outside transformed and collapsible shell containers. */
import { createPortal } from "react-dom";
import type { ActionNotice } from "../../state/types";
import { Alert } from "../ui/alert";
import { Spinner } from "../ui/spinner";

export function ActionNoticeToast({
  actionNotice,
}: {
  actionNotice: ActionNotice | null;
}) {
  if (!actionNotice || typeof document === "undefined") return null;
  return createPortal(
    <Alert
      variant={
        actionNotice.tone === "error"
          ? "toastError"
          : actionNotice.tone === "success"
            ? "toastSuccess"
            : "default"
      }
      // Passive feedback must not block controls beneath the viewport overlay.
      className="pointer-events-none fixed px-5 py-2.5 font-medium z-[10000] flex items-center gap-2.5 max-w-[min(92vw,28rem)]"
      style={{
        top: "calc(env(safe-area-inset-top, 0px) + 1rem)",
        right: "calc(env(safe-area-inset-right, 0px) + 1rem)",
      }}
      role="status"
      aria-live="polite"
      aria-busy={actionNotice.busy ? true : undefined}
      data-testid="shell-action-notice"
      data-tone={actionNotice.tone}
    >
      {actionNotice.busy ? (
        <Spinner size={16} className="shrink-0 opacity-95" aria-hidden />
      ) : null}
      <span className="min-w-0 text-left leading-snug whitespace-pre-wrap break-words">
        {actionNotice.text}
      </span>
    </Alert>,
    document.body,
  );
}
