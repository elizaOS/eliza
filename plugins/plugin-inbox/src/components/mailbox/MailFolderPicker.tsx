/**
 * The mailbox "More" folder menu (Spam, Trash, Sent, Drafts and other folders that do not fit the
 * primary row). Native top-layer popovers where supported; an explicitly hidden, unclipped fallback
 * on older WebViews (Android WebView 113 has no Popover API), whose visibility the host's central
 * Back router can query through {@link dismissMailFolderMenu}.
 *
 * Theme-neutral: the host names the CSS custom properties the portalled menu copies from the trigger
 * (the menu renders in document.body, outside the host's themed subtree) and the selected style.
 */
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export interface MailFolderOption {
  label: string;
  on?: boolean;
  disabled?: boolean;
  /** Mask image URL for the folder icon, or null for none. */
  icon?: string | null;
  pick: () => void;
}

export interface MailFolderPickerProps {
  folders: MailFolderOption[];
  /** DOM id of the portalled menu; unique per document. */
  menuId?: string;
  /** CSS custom properties copied from the trigger onto the portalled menu. */
  themeTokens?: readonly string[];
  /** Trigger style while one of these folders is selected. */
  selectedStyle?: CSSProperties;
  /** Trigger label when none of these folders is selected. */
  moreLabel?: string;
}

let activeFallback: { visible: () => boolean; dismiss: () => void } | undefined;

/** The host's central Back router consumes only an actually visible fallback menu. */
export function dismissMailFolderMenu(): boolean {
  if (!activeFallback?.visible()) return false;
  activeFallback.dismiss();
  return true;
}

export function MailFolderPicker({
  folders,
  menuId = "mail-folders",
  themeTokens = [],
  selectedStyle,
  moreLabel = "More",
}: MailFolderPickerProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const focusEdge = useRef<"first" | "last" | null>(null);
  const modern = typeof HTMLElement.prototype.showPopover === "function";
  const selected = folders.find((folder) => folder.on);
  const close = (restoreFocus = false) => {
    if (modern && menu.current)
      try {
        menu.current.hidePopover();
      } catch {
        /* Already closed or detached. */
      }
    setOpen(false);
    if (restoreFocus && trigger.current?.isConnected) trigger.current.focus();
  };
  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) || [],
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: positions only when the menu opens.
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const node = menu.current;
    const button = trigger.current;
    const theme = getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    for (const name of themeTokens)
      node.style.setProperty(name, theme.getPropertyValue(name));
    node.style.font = theme.font;
    node.style.width = `${Math.min(224, Math.max(44, window.innerWidth - 32))}px`;
    node.style.maxHeight = `${Math.max(44, window.innerHeight - 32)}px`;
    if (modern)
      try {
        node.showPopover();
      } catch {
        close(true);
        return;
      }
    const box = node.getBoundingClientRect();
    node.style.left = `${Math.max(16, Math.min(rect.right - box.width, window.innerWidth - box.width - 16))}px`;
    node.style.top = `${Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - box.height - 16))}px`;
    const edge = focusEdge.current;
    focusEdge.current = null;
    if (edge) items().at(edge === "last" ? -1 : 0)?.focus();
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: listeners exist only while the menu is open.
  useLayoutEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close();
    };
    const back = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    };
    const fallback = {
      visible: () =>
        !!menu.current &&
        !menu.current.hidden &&
        menu.current.getClientRects().length > 0,
      dismiss: () => close(true),
    };
    if (!modern) activeFallback = fallback;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") back(event);
      else if (event.key === "Tab") close();
    };
    const hidden = () => {
      if (document.hidden) close();
    };
    const resized = () => close();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", resized);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", key, true);
      if (activeFallback === fallback) activeFallback = undefined;
      window.removeEventListener("resize", resized);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [open]);
  const keyMenu = (event: ReactKeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = items();
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : index < 0
            ? event.key === "ArrowUp"
              ? buttons.length - 1
              : 0
            : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
              buttons.length;
    buttons[next].focus();
  };
  const toggle = (event: ReactMouseEvent) => {
    event.preventDefault();
    if (open) close();
    else setOpen(true);
  };
  return (
    <span
      className="mail-folder-picker"
      style={selected ? selectedStyle : undefined}
    >
      <button
        ref={trigger}
        type="button"
        className="mail-folder-trigger"
        aria-label="Other mail folders"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        popoverTarget={modern ? menuId : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusEdge.current = event.key === "ArrowUp" ? "last" : "first";
            if (open) items().at(event.key === "ArrowUp" ? -1 : 0)?.focus();
            else setOpen(true);
          }
        }}
      >
        {selected?.label || moreLabel}
        <span aria-hidden="true" className="mail-folder-chevron" />
      </button>
      {createPortal(
        <div
          ref={menu}
          id={menuId}
          className="mail-folder-menu"
          popover={modern ? "auto" : undefined}
          hidden={!open}
          role="menu"
          aria-label="Mail folders"
          onToggle={(event) => {
            if (
              modern &&
              (event.nativeEvent as ToggleEvent).newState === "closed"
            )
              setOpen(false);
          }}
          onKeyDown={keyMenu}
        >
          {folders.map((folder) => (
            <button
              key={folder.label}
              type="button"
              className="mail-folder-option"
              role="menuitemradio"
              aria-checked={folder.on === true}
              disabled={folder.disabled}
              onClick={() => {
                close(true);
                folder.pick();
              }}
            >
              <span
                aria-hidden="true"
                className="mail-folder-option-icon"
                style={
                  folder.icon
                    ? {
                        maskImage: `url('${folder.icon}')`,
                        WebkitMaskImage: `url('${folder.icon}')`,
                      }
                    : undefined
                }
              />
              <span>{folder.label}</span>
              <span
                aria-hidden="true"
                className="mail-folder-check"
                style={{ visibility: folder.on ? "visible" : "hidden" }}
              />
            </button>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
