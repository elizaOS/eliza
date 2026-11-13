/**
 * The typed commands the shell chat/voice controller accepts. OS intents are
 * routed into these commands and applied to the one live `useShellController`.
 */

import type { ImageAttachment } from "../../../api/client-types-chat";

/** Discriminated on `kind`; `applyShellControllerCommand` switches exhaustively
 *  so a new command cannot be silently dropped. */
export type ShellControllerCommand =
  | {
      kind: "open";
    }
  | {
      kind: "requestSignIn";
    }
  | {
      kind: "close";
    }
  | {
      kind: "send";
      text: string;
      channelType?: "DM" | "VOICE_DM";
      /** Image attachments — serialisable (data URLs / ids). */
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
    }
  | {
      kind: "captureVision";
    }
  | {
      kind: "toggleRecording";
    }
  | {
      kind: "startRecording";
      intent?: "converse" | "dictate" | "transcription" | "ptt";
    }
  | {
      kind: "stopRecording";
    }
  | {
      kind: "cancelRecording";
    }
  | {
      kind: "toggleHandsFree";
    }
  | {
      kind: "toggleTranscriptionMode";
    }
  | {
      kind: "stopTranscriptionAndMic";
    }
  | {
      kind: "recheckMicPermission";
    }
  | {
      kind: "speak";
      text: string;
    }
  | {
      kind: "stopSpeaking";
    }
  | {
      kind: "toggleAgentVoiceMute";
    }
  | {
      kind: "unlockAudio";
    }
  | {
      kind: "setComposerHasDraft";
      hasDraft: boolean;
    }
  | {
      kind: "clearConversation";
    }
  | {
      kind: "openSettings";
    }
  | {
      kind: "navigateHome";
    }
  | {
      kind: "stop";
    }
  | {
      kind: "navConversation";
      direction: "prev" | "next";
    };
