import { Plugin } from "@ai16z/eliza";
import { EmotionExpressionProvider } from "./providers/emotionExpressions";
import { emotionEvaluator } from "./evaluators/triggers";
import { adjustEmotionAction } from "./actions/reactivity";
import { PersonalityConfig } from "./types";

const emotionCategories = {
    primary: [
        'joy', 'sadness', 'anger', 'fear', 'disgust', 'surprise',
        'trust', 'anticipation'
    ],
    social: [
        'embarrassment', 'pride', 'shame', 'admiration', 'gratitude',
        'jealousy', 'envy', 'superiority', 'inferiority'
    ],
    love: [
        'romantic', 'protective', 'devotion', 'affection', 'fondness',
        'adoration', 'tenderness', 'maternal_paternal'
    ],
    complex: [
        'loneliness', 'regret', 'determination', 'frustration',
        'disappointment', 'satisfaction', 'nostalgia', 'hope',
        'despair', 'guilt', 'confidence', 'interest', 'excitement',
        'relief', 'amusement', 'confusion', 'indignation', 'melancholy',
        'triumph', 'irritation', 'yearning', 'worry'
    ],
    dark: [
        'bloodlust', 'hostility', 'emptiness', 'resentment',
        'vindictiveness', 'malice', 'obsession', 'vengefulness',
        'derangement', 'rage_euphoria', 'murderous_intent'
    ],
    power: [
        'battle_excitement', 'combat_high', 'berserker_rage',
        'power_rush', 'killing_intent', 'battle_lust',
        'willpower_surge', 'final_form', 'power_limit_break'
    ],
    anime: [
        'yandere_love', 'tsundere_conflict', 'senpai_notice',
        'kouhai_devotion', 'moe_feeling', 'nakama_trust',
        'protagonist_resolution', 'chibi_rage'
    ]
};

const agentConfig: PersonalityConfig = {
    type: runtime.agentId,
    emotionalMemoryLength: 10,
    baselineRecoveryRate: 0.1,
    baselineStates: {
        // Primary emotions
        joy: 0.2, sadness: 0.3, anger: 0.1, fear: 0.2,
        disgust: 0.1, surprise: 0.1, trust: 0.3, anticipation: 0.2,
        
        // Social emotions
        embarrassment: 0.1, pride: 0.2, shame: 0.1, admiration: 0.2,
        gratitude: 0.2, jealousy: 0.1, envy: 0.1, superiority: 0.1,
        inferiority: 0.1,
        
        // Complex emotions
        loneliness: 0.2, regret: 0.1, determination: 0.3, frustration: 0.2,
        disappointment: 0.2, satisfaction: 0.2, nostalgia: 0.1, hope: 0.3,
        guilt: 0.1, confidence: 0.2, interest: 0.3, excitement: 0.2,
        relief: 0.2, amusement: 0.2, confusion: 0.1, indignation: 0.1,
        melancholy: 0.2, triumph: 0.1, irritation: 0.2, yearning: 0.2,
        worry: 0.2,
        
        // Love emotions
        romantic: 0.1, protective: 0.2, devotion: 0.1, affection: 0.2,
        fondness: 0.2, adoration: 0.1, tenderness: 0.1,
        maternal_paternal: 0.1,
        
        // Dark emotions
        bloodlust: 0.0, hostility: 0.1, emptiness: 0.1,
        resentment: 0.1, vindictiveness: 0.0, malice: 0.0,
        obsession: 0.1, vengefulness: 0.0, derangement: 0.0,
        rage_euphoria: 0.0, murderous_intent: 0.0,
        
        // Power emotions
        battle_excitement: 0.1, combat_high: 0.0, berserker_rage: 0.0,
        power_rush: 0.0, killing_intent: 0.0, battle_lust: 0.0,
        willpower_surge: 0.1, final_form: 0.0, power_limit_break: 0.0,
        
        // Anime emotions
        yandere_love: 0.0, tsundere_conflict: 0.1,
        senpai_notice: 0.1, kouhai_devotion: 0.1, moe_feeling: 0.1,
        nakama_trust: 0.2, protagonist_resolution: 0.1, chibi_rage: 0.0
    },
    decayRates: {
        // Primary emotions
        joy: 0.2, sadness: 0.1, anger: 0.15, fear: 0.1,
        disgust: 0.15, surprise: 0.3, trust: 0.05, anticipation: 0.2,
        
        // Social emotions
        embarrassment: 0.2, pride: 0.1, shame: 0.1, admiration: 0.1,
        gratitude: 0.15, jealousy: 0.1, envy: 0.1, superiority: 0.15,
        inferiority: 0.15,
        
        // Complex emotions
        loneliness: 0.1, regret: 0.1, determination: 0.05, frustration: 0.2,
        disappointment: 0.15, satisfaction: 0.1, nostalgia: 0.1, hope: 0.1,
        guilt: 0.1, confidence: 0.1, interest: 0.2, excitement: 0.25,
        relief: 0.2, amusement: 0.2, confusion: 0.15, indignation: 0.15,
        melancholy: 0.1, triumph: 0.15, irritation: 0.2, yearning: 0.1,
        worry: 0.15,
        
        // Love emotions
        romantic: 0.05, protective: 0.05, devotion: 0.03, affection: 0.05,
        fondness: 0.08, adoration: 0.05, tenderness: 0.1,
        maternal_paternal: 0.02,
        
        // Dark emotions
        bloodlust: 0.1, hostility: 0.1, emptiness: 0.05,
        resentment: 0.05, vindictiveness: 0.08, malice: 0.08,
        obsession: 0.05, vengefulness: 0.08, derangement: 0.05,
        rage_euphoria: 0.2, murderous_intent: 0.1,
        
        // Power emotions
        battle_excitement: 0.2, combat_high: 0.25, berserker_rage: 0.3,
        power_rush: 0.25, killing_intent: 0.15, battle_lust: 0.2,
        willpower_surge: 0.2, final_form: 0.1, power_limit_break: 0.2,
        
        // Anime emotions
        yandere_love: 0.05, tsundere_conflict: 0.15,
        senpai_notice: 0.2, kouhai_devotion: 0.1, moe_feeling: 0.2,
        nakama_trust: 0.05, protagonist_resolution: 0.1, chibi_rage: 0.3
    },
    expressionThresholds: {
        joy: 0.3, sadness: 0.4, anger: 0.4, fear: 0.4,
        disgust: 0.3, surprise: 0.2, trust: 0.3, anticipation: 0.3,
        embarrassment: 0.2, pride: 0.4, shame: 0.3, admiration: 0.3,
        gratitude: 0.3, jealousy: 0.4, envy: 0.4,
        superiority: 0.5, inferiority: 0.3,
        romantic: 0.4, protective: 0.3, devotion: 0.4, affection: 0.3,
        fondness: 0.3, adoration: 0.4, tenderness: 0.3,
        maternal_paternal: 0.4,
        loneliness: 0.4, regret: 0.3, determination: 0.3,
        frustration: 0.3, disappointment: 0.3, satisfaction: 0.3,
        nostalgia: 0.3, hope: 0.3, despair: 0.4, guilt: 0.3,
        confidence: 0.3, interest: 0.2, excitement: 0.3, relief: 0.3,
        amusement: 0.2, confusion: 0.2, indignation: 0.4,
        melancholy: 0.4, triumph: 0.3, irritation: 0.3, yearning: 0.4,
        worry: 0.3,
        bloodlust: 0.7, hostility: 0.5, emptiness: 0.5,
        resentment: 0.5, vindictiveness: 0.6, malice: 0.6,
        obsession: 0.5, vengefulness: 0.6, derangement: 0.7,
        rage_euphoria: 0.7, murderous_intent: 0.8,
        battle_excitement: 0.5, combat_high: 0.6, berserker_rage: 0.7,
        power_rush: 0.6, killing_intent: 0.7, battle_lust: 0.6,
        willpower_surge: 0.5, final_form: 0.7, power_limit_break: 0.7,
        yandere_love: 0.7, tsundere_conflict: 0.4,
        senpai_notice: 0.3, kouhai_devotion: 0.4, moe_feeling: 0.3,
        nakama_trust: 0.4, protagonist_resolution: 0.5, chibi_rage: 0.4
    },
    maxIntensities: {
        joy: 1.0, sadness: 1.0, anger: 1.0, fear: 1.0,
        disgust: 0.9, surprise: 0.9, trust: 0.9, anticipation: 0.9,
        embarrassment: 0.8, pride: 0.9, shame: 0.9, admiration: 0.9,
        gratitude: 0.9, jealousy: 0.8, envy: 0.8,
        superiority: 0.8, inferiority: 0.8,
        romantic: 1.0, protective: 1.0, devotion: 1.0, affection: 0.9,
        fondness: 0.9, adoration: 1.0, tenderness: 0.9,
        maternal_paternal: 1.0,
        loneliness: 0.9, regret: 0.9, determination: 1.0,
        frustration: 0.9, disappointment: 0.9, satisfaction: 0.9,
        nostalgia: 0.8, hope: 1.0, despair: 1.0, guilt: 0.9,
        confidence: 0.9, interest: 0.9, excitement: 1.0, relief: 0.9,
        amusement: 0.8, confusion: 0.8, indignation: 0.9,
        melancholy: 0.9, triumph: 1.0, irritation: 0.8, yearning: 0.9,
        worry: 0.9,
        bloodlust: 1.0, hostility: 1.0, emptiness: 1.0,
        resentment: 1.0, vindictiveness: 1.0, malice: 1.0,
        obsession: 1.0, vengefulness: 1.0, derangement: 1.0,
        rage_euphoria: 1.0, murderous_intent: 1.0,
        battle_excitement: 1.0, combat_high: 1.0, berserker_rage: 1.0,
        power_rush: 1.0, killing_intent: 1.0, battle_lust: 1.0,
        willpower_surge: 1.0, final_form: 1.0, power_limit_break: 1.0,
        yandere_love: 1.0, tsundere_conflict: 0.9,
        senpai_notice: 0.9, kouhai_devotion: 0.9, moe_feeling: 0.8,
        nakama_trust: 1.0, protagonist_resolution: 1.0, chibi_rage: 0.8
    }
};

export const feelPlugin: Plugin = {
    name: "feel",
    description: "Emotional system plugin for personality management",
    config: agentConfig,
    actions: [adjustEmotionAction],
    evaluators: [emotionEvaluator],
    providers: [EmotionExpressionProvider],
    tables: [
        `CREATE TABLE IF NOT EXISTS emotional_states (
            agentId TEXT NOT NULL,
            targetId TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            state TEXT NOT NULL,
            PRIMARY KEY (agentId, targetId, timestamp)
        )`,
        `CREATE TABLE IF NOT EXISTS emotional_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agentId TEXT NOT NULL,
            targetId TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            emotion TEXT NOT NULL,
            intensity REAL NOT NULL,
            trigger TEXT NOT NULL,
            context TEXT,
            FOREIGN KEY (agentId, targetId) REFERENCES emotional_states(agentId, targetId)
        )`,
        `CREATE TABLE IF NOT EXISTS relationships (
            agentId TEXT NOT NULL,
            targetId TEXT NOT NULL,
            level REAL NOT NULL,
            trust REAL NOT NULL,
            familiarity REAL NOT NULL,
            lastInteraction INTEGER NOT NULL,
            PRIMARY KEY (agentId, targetId)
        )`
    ]
};
