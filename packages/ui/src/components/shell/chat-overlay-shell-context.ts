/**
 * Detects the Electrobun chat-overlay desktop shell (`?shellMode=chat-overlay`,
 * which tags `documentElement` with `eliza-chat-overlay-shell` — see the
 * shell-mode wiring in `@elizaos/app`'s `main.tsx` and the
 * `html.eliza-chat-overlay-shell` overrides in `styles/styles.css`).
 *
 * Components use this to drop the mobile/web viewport-centring utilities that
 * fight the shell's bottom-anchored popup geometry: Tailwind v4's
 * responsive `-translate-*` utilities emit the individual CSS `translate`
 * property, which COMPOSES with (rather than being overridden by) the
 * shell stylesheet's `transform`, and CSS-pipeline minification folds any
 * co-declared `translate: none` cancel away — the only reliable cancel is
 * to not emit the utilities in this shell at all (#20063).
 */
import * as React from "react";

const CHAT_OVERLAY_SHELL_CLASS = "eliza-chat-overlay-shell";

export function useChatOverlayShell(): boolean {
  // Initialize synchronously from the live class list: the shell mode is
  // installed on documentElement before React mounts (main.tsx shell wiring),
  // so a false-first-then-sync effect would misclassify the first render and
  // flash the viewport-centring utilities for one paint when the overlay
  // mounts already-open (#20063 round-2 review finding 1).
  const [isChatOverlayShell, setIsChatOverlayShell] = React.useState(() =>
    typeof document === "undefined"
      ? false
      : document.documentElement.classList.contains(CHAT_OVERLAY_SHELL_CLASS),
  );

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const sync = () => {
      setIsChatOverlayShell(root.classList.contains(CHAT_OVERLAY_SHELL_CLASS));
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return isChatOverlayShell;
}
