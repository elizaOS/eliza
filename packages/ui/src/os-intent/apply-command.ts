/**
 * Runs a routed {@link IntentControllerCommand} against the one live
 * {@link ShellController} — the single engine that owns chat send, mic capture,
 * and transcription. Routing (`router.ts`) never touches the DOM or the mic; it
 * emits commands and this executor is the only place they take effect, so an
 * intent can never open a second session or fight the audio owner.
 *
 * The switch is exhaustive: a command added to the union without a handler is a
 * compile error, never a silent drop.
 */
import type { ShellController } from "../components/shell/useShellController";
import type { IntentControllerCommand } from "./contract";

/**
 * The exact subset of {@link ShellController} the intent executor drives. A real
 * controller is assignable to it; narrowing the dependency keeps the executor
 * honest about what it touches (send + capture + transcription, nothing else) and
 * lets tests build a precise double with no casts.
 */
export type IntentControllerTarget = Pick<
  ShellController,
  | "open"
  | "send"
  | "startRecording"
  | "stopRecording"
  | "toggleTranscriptionMode"
  | "stopTranscriptionAndMic"
  | "transcriptionMode"
>;

export function applyOsIntentCommand(
  controller: IntentControllerTarget,
  command: IntentControllerCommand,
): void {
  switch (command.kind) {
    case "open":
      controller.open();
      return;
    case "send":
      controller.send(command.text, {
        ...(command.channelType ? { channelType: command.channelType } : {}),
        ...(command.images ? { images: command.images } : {}),
        ...(command.metadata ? { metadata: command.metadata } : {}),
      });
      return;
    case "startRecording":
      controller.startRecording(command.intent);
      return;
    case "stopRecording":
      controller.stopRecording();
      return;
    case "toggleTranscriptionMode":
      // Idempotent start: only toggle ON when transcription is not already
      // running, so a redelivered start-transcription command can never toggle a
      // live session OFF. The intent dedupe store prevents most redelivery; this
      // guards the residual race where two windows apply before the snapshot syncs.
      if (!controller.transcriptionMode)
        void controller.toggleTranscriptionMode();
      return;
    case "stopTranscriptionAndMic":
      void controller.stopTranscriptionAndMic();
      return;
    default: {
      const _exhaustive: never = command;
      // Unreachable: the union is exhausted above, so a new command kind is a
      // compile error at the assignment. Fail fast if one slips through at runtime.
      throw new Error(
        `[applyOsIntentCommand] unhandled command: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/** Apply an ordered command list (an intent's full effect) in sequence. */
export function applyOsIntentCommands(
  controller: IntentControllerTarget,
  commands: readonly IntentControllerCommand[],
): void {
  for (const command of commands) applyOsIntentCommand(controller, command);
}
