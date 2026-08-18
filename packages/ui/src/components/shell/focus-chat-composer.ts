/**
 * Preserves a desktop chat-open focus request until the lazily mounted composer
 * is present, then focuses it exactly once and releases the observer.
 */

const CHAT_COMPOSER_SELECTOR = '[data-testid="chat-composer-textarea"]';

/** Focus the chat composer now or as soon as its overlay commits to the DOM. */
export function focusChatComposerWhenReady(
  onFocused: () => void,
  root: Document = document,
): () => void {
  let observer: MutationObserver | null = null;
  let cancelled = false;

  const focusComposer = (): boolean => {
    if (cancelled) return false;
    const composer = root.querySelector<HTMLTextAreaElement>(
      CHAT_COMPOSER_SELECTOR,
    );
    if (!composer) return false;

    composer.focus({ preventScroll: true });
    observer?.disconnect();
    observer = null;
    onFocused();
    return true;
  };

  if (!focusComposer()) {
    observer = new MutationObserver(focusComposer);
    observer.observe(root.documentElement, { childList: true, subtree: true });
    // Close the gap between the initial query and observer registration.
    focusComposer();
  }

  return () => {
    cancelled = true;
    observer?.disconnect();
    observer = null;
  };
}
