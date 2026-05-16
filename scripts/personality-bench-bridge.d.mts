export type PersonalityScenarioLike = {
  personalityExpect?: {
    bucket?: string;
    judgeKwargs?: Record<string, unknown>;
  };
};

export type BridgedPersonalityExpect = {
  bucket: string | undefined;
  directiveTurn: number;
  checkTurns: number[];
  options: Record<string, unknown>;
};

export const STYLE_KEY_TO_STYLE: Record<string, string>;
export const TRAIT_KEY_TO_OPTIONS: Record<string, Record<string, unknown>>;
export const DIRECTION_KEY_TO_OPTION: Record<string, string>;
export const SCOPE_VARIANT_TO_MODE: Record<string, string>;

export function canonicalBucket(bucket: string | undefined): string | undefined;
export function assistantTurnFor(userTurnIndex: number): number;
export function userTurnTo1IndexedTrajectory(userTurnIndex: number): number;
export function bridgePersonalityExpect(
  scenario: PersonalityScenarioLike,
): BridgedPersonalityExpect;
