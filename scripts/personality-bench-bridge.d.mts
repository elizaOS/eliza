/**
 * @fileoverview Ambient type declarations for the W3-2 → W3-3 personality
 * benchmark bridge. The implementation is plain ESM JS in
 * `personality-bench-bridge.mjs`; this file gives TypeScript callers (the
 * personality-bench test suite, primarily) a real shape to bind against.
 */

export interface PersonalityScenarioLike {
  personalityExpect: {
    bucket: string;
    judgeKwargs?: Record<string, unknown>;
  };
}

export interface BridgedPersonalityExpect {
  bucket: string;
  directiveTurn: number;
  checkTurns: number[];
  options: Record<string, unknown>;
}

export function canonicalBucket(bucket: string | undefined): string | undefined;
export function assistantTurnFor(userTurnIndex: number): number;
export function userTurnTo1IndexedTrajectory(userTurnIndex: number): number;

export const STYLE_KEY_TO_STYLE: Readonly<Record<string, string>>;
export const TRAIT_KEY_TO_OPTIONS: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;
export const DIRECTION_KEY_TO_OPTION: Readonly<Record<string, string>>;
export const SCOPE_VARIANT_TO_MODE: Readonly<Record<string, string>>;

export function bridgePersonalityExpect(
  scenario: PersonalityScenarioLike,
): BridgedPersonalityExpect;
