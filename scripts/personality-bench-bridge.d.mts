export interface PersonalityScenarioLike {
  personalityExpect?: {
    bucket?: string;
    judgeKwargs?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export const STYLE_KEY_TO_STYLE: Record<string, string>;

export const TRAIT_KEY_TO_OPTIONS: Record<string, Record<string, unknown>>;

export function bridgePersonalityExpect(
  scenario: PersonalityScenarioLike,
): {
  bucket: string | undefined;
  directiveTurn: number;
  checkTurns: number[];
  options: Record<string, unknown>;
  [key: string]: unknown;
};
