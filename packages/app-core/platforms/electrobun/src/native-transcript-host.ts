/**
 * Electrobun's native transcript host. It validates and reduces renderer
 * envelopes with the dependency-light shared contract, retaining an inspectable
 * native view model for desktop-owned windows and diagnostics.
 */

import {
  applyTranscriptEvent,
  decodeTranscriptStream,
  initialReducerState,
  type TranscriptReducerState,
  type TranscriptViewModel,
  toViewModel,
} from "../../../../ui/src/native-transcript/core";

let reducerState: TranscriptReducerState = initialReducerState();

export interface NativeTranscriptHostResult {
  view: TranscriptViewModel;
  rejectedIndexes: number[];
}

/** Validate and append one renderer envelope to the desktop-native reducer. */
export function publishNativeTranscriptStream(
  input: unknown,
): NativeTranscriptHostResult {
  const decoded = decodeTranscriptStream(input);
  for (const event of decoded.events) {
    reducerState = applyTranscriptEvent(reducerState, event);
  }
  return {
    view: structuredClone(toViewModel(reducerState)),
    rejectedIndexes: decoded.rejected.map((rejection) => rejection.index),
  };
}

/** Read the native host's current immutable render projection. */
export function readNativeTranscriptViewModel(): TranscriptViewModel {
  return structuredClone(toViewModel(reducerState));
}

export function resetNativeTranscriptHostForTests(): void {
  reducerState = initialReducerState();
}
