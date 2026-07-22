/**
 * Electrobun's transcript host. It validates and reduces renderer envelopes
 * with the dependency-light contract, then returns that view model to the
 * shipped desktop chat/voice surface for visible rendering.
 */

import {
  applyTranscriptEvent,
  decodeTranscriptStream,
  initialReducerState,
  type TranscriptReducerState,
  type TranscriptViewModel,
  toViewModel,
} from "../../../../ui/src/native-transcript/core";
import { logger } from "./logger";

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
  const view = structuredClone(toViewModel(reducerState));
  logger.debug("[NativeTranscript] Applied desktop transcript batch", {
    lastSeq: view.lastSeq,
    rejectedIndexes: decoded.rejected.map((rejection) => rejection.index),
  });
  return {
    view,
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
