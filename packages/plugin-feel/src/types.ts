export interface EmotionalState {
    // Primary emotions
    joy: number;
    sadness: number;
    anger: number;
    fear: number;
    disgust: number;
    surprise: number;
    trust: number;
    anticipation: number;

    // Social emotions
    embarrassment: number;
    pride: number;
    shame: number;
    admiration: number;
    gratitude: number;
    jealousy: number;
    envy: number;
    superiority: number;
    inferiority: number;

    // Love emotions
    romantic: number;
    protective: number;
    devotion: number;
    affection: number;
    fondness: number;
    adoration: number;
    tenderness: number;
    maternal_paternal: number;

    // Complex emotions
    loneliness: number;
    regret: number;
    determination: number;
    frustration: number;
    disappointment: number;
    satisfaction: number;
    nostalgia: number;
    hope: number;
    guilt: number;
    confidence: number;
    interest: number;
    excitement: number;
    relief: number;
    amusement: number;
    confusion: number;
    indignation: number;
    melancholy: number;
    triumph: number;
    irritation: number;
    yearning: number;
    worry: number;

    // Dark emotions
    bloodlust: number;
    hostility: number;
    emptiness: number;
    resentment: number;
    vindictiveness: number;
    malice: number;
    obsession: number;
    vengefulness: number;
    derangement: number;
    rage_euphoria: number;
    murderous_intent: number;

    // Power emotions
    battle_excitement: number;
    combat_high: number;
    berserker_rage: number;
    power_rush: number;
    killing_intent: number;
    battle_lust: number;
    willpower_surge: number;
    final_form: number;
    power_limit_break: number;

    // Anime emotions
    yandere_love: number;
    tsundere_conflict: number;
    senpai_notice: number;
    kouhai_devotion: number;
    moe_feeling: number;
    nakama_trust: number;
    protagonist_resolution: number;
    chibi_rage: number;

    // Required metadata
    timestamp: number;
    profile: string;
    dominantEmotion?: string;
}

export interface RelationshipStatus {
    userId: string;
    level: number;           // -1 to 1, representing negative to positive relationship
    trust: number;          // 0 to 1
    familiarity: number;    // 0 to 1
    lastInteraction: number;
}

export interface SituationContext {
    isPublic: boolean;      // Public vs private conversation
    formality: number;      // 0 to 1, how formal the situation is
    stress: number;         // 0 to 1, environmental stress level
    safety: number;         // 0 to 1, how safe/secure the situation feels
}

export interface PersonalityTraits {
    emotionalRestraint: number;     // How much emotions are suppressed (0-1)
    socialAnxiety: number;          // Affects reactions in social situations (0-1)
    attachmentStyle: 'secure' | 'anxious' | 'avoidant' | 'fearful';
    expressiveness: number;         // How readily emotions are shown (0-1)
}

export interface EmotionalContext {
    currentState: EmotionalState;
    recentHistory: EmotionalState[];
    relationships: Map<string, RelationshipStatus>;
    situationalFactors: SituationContext;
    personalityModifiers: PersonalityTraits;
}

export interface EmotionalTrigger {
    trigger: string;
    emotion: keyof EmotionalState;
    intensity: number;
    response_style: string;
}

export interface EmotionalMemory {
    timestamp: number;
    userId: string;
    emotion: keyof EmotionalState;
    intensity: number;
    trigger: string;
    context: Partial<SituationContext>;
}

export interface EmotionalExpression {
    minScore: number;
    expressions: string[];
    priority?: number;
}

export interface PersonalityConfig {
    type: 'kuudere' | 'tsundere' | 'dandere' | 'deredere';
    emotionalMemoryLength: number;
    baselineRecoveryRate: number;
    expressionThresholds: {
        [key in keyof EmotionalState]?: number;
    };
    maxIntensities: {
        [key in keyof EmotionalState]?: number;
    };
    decayRates: {
        [key in keyof EmotionalState]?: number;
    };
}

// Emotional Interaction System
export interface EmotionalInteraction {
    targetEmotion: keyof EmotionalState;
    effect: number;           // Multiplier for the effect
    threshold?: number;       // Minimum source emotion level to trigger
    decay?: number;          // How quickly the interaction effect fades
}

export interface EmotionalInteractions {
    [sourceEmotion: string]: {
        [targetEmotion: string]: EmotionalInteraction;
    };
}
