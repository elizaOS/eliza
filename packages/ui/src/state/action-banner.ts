/**
 * A top-of-shell action banner: a full-width banner (above the shell content,
 * not a bottom toast) that carries an optional primary action CTA. Used for
 * prompts the user must act on before continuing — e.g. "choose a model
 * provider in Settings before sending the first message."
 *
 * Distinct from {@link ActionNotice} (a transient bottom-center toast with no
 * CTA) and from `systemWarnings` (plain strings that auto-dismiss after 20s).
 * One banner at a time.
 */
export interface ActionBanner {
  text: string;
  /** Label for the primary action button; omit to render dismiss-only. */
  actionLabel?: string;
  /** Invoked when the primary action button is pressed. */
  onAction?: () => void;
}
