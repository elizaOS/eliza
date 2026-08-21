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

export interface ChatAccessoryBarController {
  initializeBaseline(): Promise<void>;
  setChatComposerHidden(hidden: boolean): Promise<void>;
}

export function createChatAccessoryBarController({
  enabled,
  loadKeyboard,
  reportError,
}: {
  enabled: boolean;
  loadKeyboard: KeyboardAccessoryLoader;
  reportError: (error: unknown) => void;
}): ChatAccessoryBarController {
  let update = Promise.resolve();
  let chatComposerHidden = false;
  let appliedHidden: boolean | undefined;

  const enqueueReconciliation = (): Promise<void> => {
    if (!enabled) return Promise.resolve();
    update = update
      .then(async () => {
        const Keyboard = await loadKeyboard();
        // Loading the bridge can outlive the focus that requested this turn.
        // Read the desired state only after that await so an already-blurred
        // composer cannot transiently hide the accessory for the next field.
        const targetHidden = chatComposerHidden;
        if (appliedHidden === targetHidden) return;
        await Keyboard.setAccessoryBarVisible({ isVisible: !targetHidden });
        appliedHidden = targetHidden;
      })
      .catch((error) => {
        // error-policy:J7 native keyboard-bridge diagnostics must not kill the
        // focus loop. This narrows no error shape and renders no distinguishable
        // state, so it is a diagnostics catch rather than a J4 degrade: the
        // accessory bar simply keeps whatever visibility the WebView gave it.
        reportError(error);
      });
    return update;
  };

  return {
    initializeBaseline(): Promise<void> {
      // Boot can finish after React mounts and the composer takes focus. Apply
      // the current owner state instead of blindly restoring the global bar.
      return enqueueReconciliation();
    },
    setChatComposerHidden(hidden: boolean): Promise<void> {
      chatComposerHidden = hidden;
      return enqueueReconciliation();
    },
  };
}

const chatAccessoryBarController = createChatAccessoryBarController({
  enabled: isNative && isIOS,
  loadKeyboard: async () => {
    const { Keyboard } = await import("@capacitor/keyboard");
    return Keyboard;
  },
  reportError: (error) => {
    logger.warn(
      { error },
      "[ios-chat-accessory-bar] iOS keyboard accessory visibility unavailable",
    );
  },
});

/** Reconciles boot's ordinary-form baseline with any already-focused chat. */
export function initializeIosKeyboardAccessoryBar(): Promise<void> {
  return chatAccessoryBarController.initializeBaseline();
}

export function setChatComposerAccessoryBarHidden(hidden: boolean): void {
  void chatAccessoryBarController.setChatComposerHidden(hidden);
}
