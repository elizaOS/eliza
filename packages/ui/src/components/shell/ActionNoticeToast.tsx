/** Renders passive action feedback consistently in the main shell and detached desktop windows. */
import type { ActionNotice } from "../../state/types";
import { Spinner } from "../ui/spinner";

export function ActionNoticeToast({
  actionNotice,
}: {
  actionNotice: ActionNotice | null;
}) {
  if (!actionNotice) return null;
  return (
    <div
      // A `role="status"` toast is a passive announcement with no
      // interactive controls (spinner + text only); at `z-[10000]` it sits
      // above the whole shell, so without `pointer-events-none` it silently
      // eats clicks on whatever it overlaps (e.g. the bottom-center chat
      // pill) while it lingers. Let pointer events fall through to the UI
      // beneath it.
      className={`pointer-events-none fixed bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-sm text-sm font-medium z-[10000] flex items-center gap-2.5 max-w-[min(92vw,28rem)] ${
        actionNotice.tone === "error"
          ? "bg-danger text-white"
          : actionNotice.tone === "success"
            ? "bg-ok text-white"
            : "bg-accent text-accent-fg"
      }`}
      role="status"
      aria-live="polite"
      aria-busy={actionNotice.busy ? true : undefined}
      data-testid="shell-action-notice"
      data-tone={actionNotice.tone}
    >
      {actionNotice.busy ? (
        <Spinner size={16} className="shrink-0 opacity-95" aria-hidden />
      ) : null}
      <span className="text-left leading-snug">{actionNotice.text}</span>
    </div>
  );
}
