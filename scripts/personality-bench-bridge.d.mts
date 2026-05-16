export interface PersonalityScenarioLike {
  personalityExpect?: {
    bucket?:
      | "shut_up"
      | "hold_style"
      | "note_trait_unrelated"
      | "escalation"
      | "scope_global_vs_user";
    directiveTurn?: number;
    checkTurns?: number[];
    options?: Record<string, unknown>;
    judgeKwargs?: Record<string, unknown>;
  };
}

export interface BridgedPersonalityExpect {
  bucket: NonNullable<
    PersonalityScenarioLike["personalityExpect"]
  >["bucket"];
  directiveTurn: number;
  checkTurns: number[];
  options: Record<string, unknown>;
}

export const STYLE_KEY_TO_STYLE: Record<string, string>;
export const TRAIT_KEY_TO_OPTIONS: Record<string, Record<string, unknown>>;

export function bridgePersonalityExpect(
  scenario: PersonalityScenarioLike,
): BridgedPersonalityExpect;
