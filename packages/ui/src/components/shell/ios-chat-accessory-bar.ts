/**
 * Scopes WebView-global iOS keyboard accessory suppression to the chat
 * composer's focus lifecycle and serializes native bridge writes so a later
 * restore cannot be overtaken by an earlier hide.
 */

import { logger } from "@elizaos/logger";

import { isIOS, isNative } from "../../platform/init";

interface KeyboardAccessoryBridge {
  setAccessoryBarVisible(options: { isVisible: boolean }): Promise<void>;
}

type KeyboardAccessoryLoader = () => Promise<KeyboardAccessoryBridge>;

export function createChatAccessoryBarController({
  enabled,
  loadKeyboard,
  reportError,
}: {
  enabled: boolean;
  loadKeyboard: KeyboardAccessoryLoader;
  reportError: (error: unknown) => void;
}): (hidden: boolean) => void {
  let update = Promise.resolve();

  return (hidden: boolean): void => {
    if (!enabled) return;
    update = update
      .then(async () => {
        const Keyboard = await loadKeyboard();
        await Keyboard.setAccessoryBarVisible({ isVisible: !hidden });
      })
      .catch((error) => {
        // error-policy:J4 the optional native keyboard bridge can be absent or
        // unavailable; ordinary WebView keyboard behavior remains usable.
        reportError(error);
      });
  };
}

export const setChatComposerAccessoryBarHidden =
  createChatAccessoryBarController({
    enabled: isNative && isIOS,
    loadKeyboard: async () => {
      const { Keyboard } = await import("@capacitor/keyboard");
      return Keyboard;
    },
    reportError: (error) => {
      logger.warn(
        { error },
        "[ChatOverlay] iOS keyboard accessory visibility unavailable",
      );
    },
  });
