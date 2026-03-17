/**
 * Voice Call module for the Twilio plugin.
 *
 * Provides advanced voice call capabilities with call lifecycle management,
 * transcript tracking, and bidirectional conversation support.
 */

import type { ServiceClass } from "@elizaos/core";
import {
  continueCallAction,
  endCallAction,
  getCallStatusAction,
  initiateCallAction,
  speakToUserAction,
  voiceCallMakeCallAction,
} from "./actions";
import { callContextProvider, voiceCallStateProvider } from "./providers";
import { VoiceCallService } from "./service";

// Re-export everything
export * from "./actions";
export * from "./client";
export * from "./constants";
export * from "./environment";
export * from "./providers";
export * from "./service";
export * from "./types";

/**
 * Voice call service class for plugin registration.
 */
export const voiceCallServiceClass = VoiceCallService as unknown as ServiceClass;

/**
 * All voice call actions.
 */
export const voiceCallActions = [
  initiateCallAction,
  voiceCallMakeCallAction,
  continueCallAction,
  speakToUserAction,
  endCallAction,
  getCallStatusAction,
];

/**
 * All voice call providers.
 */
export const voiceCallProviders = [callContextProvider, voiceCallStateProvider];
