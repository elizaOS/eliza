/**
 * Client-side shouldRespond / echo-rejection gate for always-on voice.
 *
 * The implementation is the canonical, pure definition in
 * `@elizaos/shared/voice/respond-gate` — the SAME code the Voice Workbench
 * headless runner exercises (issue #8785), so what we test is exactly what the
 * client ships. This module re-exports it to keep the existing
 * `@elizaos/ui` `voice/should-respond` import path (and its tests) stable.
 */

export {
  ECHO_OVERLAP_THRESHOLD,
  ECHO_WINDOW_MS,
  type ShouldRespondContext,
  shouldRespondToVoiceTurn,
} from "@elizaos/shared/voice/respond-gate";
