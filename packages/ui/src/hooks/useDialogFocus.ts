import { type RefObject, useEffect, useEffectEvent } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const dialogs: HTMLElement[] = [];

/** Focus only the topmost open modal and restore its trigger on close. */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onEscape?: () => void,
): void {
  const handleEscape = useEffectEvent(() => onEscape?.());
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          element.tabIndex >= 0 && !element.closest("[hidden], [inert]"),
      );
    dialogs.push(dialog);
    (focusable()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog || event.defaultPrevented) return;
      if (event.key === "Escape") {
        handleEscape();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (
        event.shiftKey &&
        (active === first || active === dialog || !dialog.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const topmost = dialogs.at(-1) === dialog;
      dialogs.splice(dialogs.indexOf(dialog), 1);
      if (topmost && previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [open, ref]);
}
