export interface PersonalityScenarioLike {
  personalityExpect?: {
    bucket?: string;
    directiveTurn?: number;
    checkTurns?: number[];
    options?: Record<string, unknown>;
    judgeKwargs?: Record<string, unknown>;
  };
}

export interface BridgedPersonalityExpect {
  bucket: unknown;
  directiveTurn: number;
  checkTurns: number[];
  options: Record<string, unknown>;
}

export const STYLE_KEY_TO_STYLE: Readonly<Record<string, string>>;
export const TRAIT_KEY_TO_OPTIONS: Readonly<
  Record<string, Record<string, unknown>>
>;
export const SCOPE_VARIANT_TO_MODE: Readonly<Record<string, string>>;
export function bridgePersonalityExpect(
  scenario: PersonalityScenarioLike,
): BridgedPersonalityExpect;
