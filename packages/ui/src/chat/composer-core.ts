/**
 * Headless composer core shared by every chat input surface. One
 * implementation of the composer keyboard contract — IME-safe Enter-to-send
 * (#9148), slash-menu key interception, Shift+Enter newline, Escape — and of
 * the clipboard contract — a pasted image/file attaches, an oversized text
 * paste becomes a collapsed text-attachment chip, small text falls through to
 * the input (#12188 Phase 3).
 *
 * Together with `useChatComposerOrLocal` (draft state,
 * state/ChatComposerContext.hooks.ts) and `usePushToTalk` (mic hold machine,
 * hooks/usePushToTalk.ts) this is the composer core: ContinuousChatOverlay,
 * ChatComposer (ChatView), and ChatSurface are thin chrome over these hooks.
 * Before the core existed each surface hand-rolled its own keydown/paste and
 * the behavior drifted — the IME guard shipped only on the overlay, so a CJK
 * candidate commit sent the message on the other two surfaces.
 */

import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useCallback, useRef } from "react";
import type { ImageAttachment } from "../api";
import { classifyComposerPaste } from "../utils/image-attachment";

/**
 * True for the Enter keydown that commits an IME composition: while a
 * CJK/other IME is composing, the browser fires Enter with `isComposing` set
 * (legacy engines report keyCode 229) and the key only accepts the candidate.
 * That Enter must never send or run a slash command — let it fall through to
 * the input/IME as its default (#9148).
 */
export function isImeComposingEnter(
  event: ReactKeyboardEvent<HTMLElement>,
): boolean {
  return (
    event.key === "Enter" &&
    (event.nativeEvent.isComposing || event.keyCode === 229)
  );
}

/**
 * Slash-menu keyboard binding consumed by {@link useComposerKeydown}. Each
 * method owns its whole effect (e.g. `complete` writes the completed text into
 * the draft itself) and reports whether it handled the key, so the core stays
 * decoupled from the menu's state shape.
 */
export interface ComposerSlashKeydown {
  /** Whether the menu is open — interception only applies while it is. */
  open: boolean;
  /** ArrowDown/ArrowUp — move the active option by `delta`. */
  move(delta: number): void;
  /** Tab — complete the active item into the draft. True when handled. */
  complete(): boolean;
  /**
   * Enter — resolve and run the active item. True when handled; false lets
   * the Enter fall through to the normal send.
   */
  submit(): boolean;
  /** Escape — dismiss the menu, keeping the draft. */
  dismiss(): void;
}

export interface ComposerKeydownOptions {
  /** Enter (no Shift, no composing IME) sends. */
  onSend: () => void;
  /** Slash-menu interception, consulted while its `open` flag is true. */
  slash?: ComposerSlashKeydown;
  /**
   * Escape with no slash menu open (e.g. the overlay collapses its sheet).
   * Return true when consumed so the core preventDefaults it.
   */
  onEscape?: () => boolean;
  /** Ignore every key while locked (mirrors the disabled-input guard). */
  locked?: boolean;
}

/**
 * The one composer keydown handler. Ordering is the contract: locked guard →
 * IME-commit Enter passthrough → slash-menu interception (ArrowUp/ArrowDown/
 * Tab/Enter/Escape) → Enter sends (Shift+Enter falls through as a newline) →
 * Escape surface hook. Returns a stable handler; options are read through a
 * ref so surfaces may pass fresh closures every render.
 */
export function useComposerKeydown<T extends HTMLElement>(
  options: ComposerKeydownOptions,
): (event: ReactKeyboardEvent<T>) => void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  return useCallback((event: ReactKeyboardEvent<T>) => {
    const { onSend, slash, onEscape, locked } = optionsRef.current;
    if (locked) return;
    if (isImeComposingEnter(event)) return;
    if (slash?.open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        slash.move(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        slash.move(-1);
        return;
      }
      // An uncompleted Tab (no active item) falls through to the browser's
      // focus move; a handled one stays in the input on the completed draft.
      if (event.key === "Tab" && slash.complete()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && slash.submit()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        // stopPropagation so outer Escape handlers (sheet collapse, dialog
        // close) don't also fire — dismissing the menu is the whole effect.
        event.preventDefault();
        event.stopPropagation();
        slash.dismiss();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
      return;
    }
    if (event.key === "Escape" && onEscape?.()) {
      event.preventDefault();
    }
  }, []);
}

export interface ComposerPasteOptions {
  /** Intake pasted files (the surface's attachment pipeline). */
  addFiles: (files: File[]) => void;
  /** Attach an oversized text paste as a collapsed text-attachment chip. */
  attachText: (attachment: ImageAttachment) => void;
}

/**
 * The one composer paste handler: routes the clipboard through
 * `classifyComposerPaste` — files attach, a large text block becomes a
 * text-attachment chip (both preventDefault), small text falls through to the
 * input as a normal paste. Pass `undefined` on surfaces without outbound
 * attachments to get no handler.
 */
export function useComposerPaste<T extends HTMLElement>(
  options: ComposerPasteOptions | undefined,
): ((event: ReactClipboardEvent<T>) => void) | undefined {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handlePaste = useCallback((event: ReactClipboardEvent<T>) => {
    const current = optionsRef.current;
    if (!current) return;
    const intent = classifyComposerPaste({
      files: Array.from(event.clipboardData?.files ?? []),
      text: event.clipboardData?.getData("text") ?? "",
    });
    if (intent.kind === "files") {
      event.preventDefault();
      current.addFiles(intent.files);
      return;
    }
    if (intent.kind === "text-attachment") {
      event.preventDefault();
      current.attachText(intent.attachment);
    }
  }, []);

  return options ? handlePaste : undefined;
}
