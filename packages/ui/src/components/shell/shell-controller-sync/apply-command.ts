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
): Promise<void> {
  switch (command.kind) {
    case "open":
      return Promise.resolve(controller.open());
    case "close":
      return Promise.resolve(controller.close());
    case "send":
      return Promise.resolve(
        controller.send(command.text, {
          ...(command.channelType ? { channelType: command.channelType } : {}),
          ...(command.images ? { images: command.images } : {}),
          ...(command.metadata ? { metadata: command.metadata } : {}),
        }),
      );
    case "captureVision":
      return Promise.resolve(controller.captureVision());
    case "toggleRecording":
      return Promise.resolve(controller.toggleRecording());
    case "startRecording":
      return Promise.resolve(controller.startRecording(command.intent));
    case "stopRecording":
      return Promise.resolve(controller.stopRecording());
    case "toggleHandsFree":
      return Promise.resolve(controller.toggleHandsFree());
    case "toggleTranscriptionMode":
      return Promise.resolve(controller.toggleTranscriptionMode());
    case "stopTranscriptionAndMic":
      return Promise.resolve(controller.stopTranscriptionAndMic());
    case "recheckMicPermission":
      return Promise.resolve(controller.recheckMicPermission()).then(() => {});
    case "speak":
      return Promise.resolve(controller.speak(command.text));
    case "stopSpeaking":
      return Promise.resolve(controller.stopSpeaking());
    case "toggleAgentVoiceMute":
      return Promise.resolve(controller.toggleAgentVoiceMute());
    case "unlockAudio":
      return Promise.resolve(controller.unlockAudio());
    case "setComposerHasDraft":
      return Promise.resolve(controller.setComposerHasDraft(command.hasDraft));
    case "clearConversation":
      return Promise.resolve(controller.clearConversation());
    case "openSettings":
      return Promise.resolve(controller.openSettings());
    case "navigateHome":
      return Promise.resolve(controller.navigateHome?.());
    case "stop":
      return Promise.resolve(controller.stop());
    case "navConversation":
      return Promise.resolve(
        command.direction === "prev"
          ? controller.conversationNav.goPrev()
          : controller.conversationNav.goNext(),
      );
    case "routeOsIntent":
      return Promise.reject(
        new Error(
          "OS intents must be evaluated by the owner routing authority",
        ),
      );
    default: {
      const _exhaustive: never = command;
      return Promise.reject(
        new Error(`unhandled shell command: ${_exhaustive}`),
      );
    }
  }
}
