/**
 * Owner-side inverse of the follower controller: run a follower's typed command
 * against the one live `useShellController` engine (#16442). The owner window is
 * the sole place mic capture, TTS, and the conversation session actually happen;
 * every follower interaction arrives here as a command and is applied exactly
 * once (the coordinator dedupes before calling this).
 *
 * The switch is exhaustive so a command added to the union without a handler is
 * a compile error, never a silent drop.
 */
import type { ShellController } from "../useShellController";
import type { ShellControllerCommand } from "./protocol";

export function applyShellControllerCommand(
  controller: ShellController,
  command: ShellControllerCommand,
): void {
  switch (command.kind) {
    case "open":
      controller.open();
      return;
    case "close":
      controller.close();
      return;
    case "send":
      controller.send(command.text, {
        ...(command.channelType ? { channelType: command.channelType } : {}),
        ...(command.images ? { images: command.images } : {}),
        ...(command.metadata ? { metadata: command.metadata } : {}),
      });
      return;
    case "captureVision":
      controller.captureVision();
      return;
    case "toggleRecording":
      controller.toggleRecording();
      return;
    case "startRecording":
      controller.startRecording(command.intent);
      return;
    case "stopRecording":
      controller.stopRecording();
      return;
    case "toggleHandsFree":
      controller.toggleHandsFree();
      return;
    case "toggleTranscriptionMode":
      void controller.toggleTranscriptionMode();
      return;
    case "stopTranscriptionAndMic":
      void controller.stopTranscriptionAndMic();
      return;
    case "recheckMicPermission":
      void controller.recheckMicPermission();
      return;
    case "speak":
      controller.speak(command.text);
      return;
    case "stopSpeaking":
      controller.stopSpeaking();
      return;
    case "toggleAgentVoiceMute":
      controller.toggleAgentVoiceMute();
      return;
    case "unlockAudio":
      controller.unlockAudio();
      return;
    case "setComposerHasDraft":
      controller.setComposerHasDraft(command.hasDraft);
      return;
    case "clearConversation":
      controller.clearConversation();
      return;
    case "openSettings":
      controller.openSettings();
      return;
    case "navigateHome":
      controller.navigateHome?.();
      return;
    case "stop":
      controller.stop();
      return;
    case "navConversation":
      if (command.direction === "prev") controller.conversationNav.goPrev();
      else controller.conversationNav.goNext();
      return;
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}
