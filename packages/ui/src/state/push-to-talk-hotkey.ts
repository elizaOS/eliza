/**
 * Durable push-to-talk accelerator shared by desktop startup and Settings.
 * The synchronous getter lets the desktop register the persisted value before
 * React mounts, while the setter is called only after native registration wins.
 */

import { shellLocalStorage } from "../surface-realm-channel";

const STORAGE_KEY = "eliza:pushToTalkHotkey";

export const DEFAULT_PUSH_TO_TALK_ACCELERATOR = "CommandOrControl+Shift+Space";

function normalizeAccelerator(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const modifiers = new Set(["CommandOrControl", "Control", "Alt", "Shift"]);
  const key = tokens.at(-1);
  const modifierTokens = tokens.slice(0, -1);
  const hasDuplicateModifier =
    new Set(modifierTokens).size !== modifierTokens.length;
  const printableKey = key !== undefined && /^[A-Z0-9]$/i.test(key);
  const validKey =
    key !== undefined &&
    (printableKey ||
      /^(Space|Escape|Enter|Backspace|Tab|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-9]|2[0-4]))$/i.test(
        key,
      ));
  if (
    !validKey ||
    (printableKey && modifierTokens.length === 0) ||
    hasDuplicateModifier ||
    modifierTokens.some((token) => !modifiers.has(token))
  ) {
    return null;
  }
  return tokens.join("+");
}

export function getPushToTalkAccelerator(): string {
  if (typeof window === "undefined") return DEFAULT_PUSH_TO_TALK_ACCELERATOR;
  try {
    return (
      normalizeAccelerator(window.localStorage.getItem(STORAGE_KEY)) ??
      DEFAULT_PUSH_TO_TALK_ACCELERATOR
    );
  } catch {
    // error-policy:J4 storage unavailability visibly degrades to the documented default.
    return DEFAULT_PUSH_TO_TALK_ACCELERATOR;
  }
}

export function setPushToTalkAccelerator(accelerator: string): void {
  const normalized = normalizeAccelerator(accelerator);
  if (!normalized) throw new Error("A push-to-talk accelerator is required.");
  shellLocalStorage.setItem(STORAGE_KEY, normalized);
}
