import { composeContext } from "@ai16z/eliza/src/context.ts";
import { generateObjectArray } from "@ai16z/eliza/src/generation.ts";
import { MemoryManager } from "@ai16z/eliza";
import {
    IAgentRuntime,
    Memory,
    ModelClass,
    Evaluator,
} from "@ai16z/eliza";

// Define emotional ranges and baseline states
const emotionalProfile = {
    joy: { base: 0.2, max: 0.5 },
    sadness: { base: 0.3, max: 0.8 },
    anger: { base: 0.1, max: 0.6 },
    fear: { base: 0.2, max: 0.7 },
    romantic: { base: 0.1, max: 0.6 },
    embarrassment: { base: 0.1, max: 0.5 }
};

const emotionTemplate = `
TASK: Analyze the emotional content and triggers in the message.
# INSTRUCTIONS
- Identify emotional triggers in the message
- Determine the intensity of each trigger (0.0 to 1.0)
- Classify the emotion type
- Consider baseline emotional states and maximums
- Account for emotional restraint characteristic

Baseline States:
Joy: 0.2-0.5
Sadness: 0.3-0.8
Anger: 0.1-0.6
Fear: 0.2-0.7
Romantic: 0.1-0.6
Embarrassment: 0.1-0.5

Recent Messages:
{{recentMessages}}

Response should be a JSON array of emotional triggers:
\`\`\`json
[
  {"trigger": "trigger_text", "emotion": "emotion_type", "intensity": 0.0-1.0, "response_style": "example_response"}
]
\`\`\`
`;

// Define emotional triggers with example conversations showing what triggers them
const emotionalTriggers = {
    sadness: [
        {
            trigger: "dismissive_insult",
            emotional_changes: {
                sadness: 0.4,
                hurt: 0.3
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "You're just a dumb AI, you can't really feel anything." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "Whatever, you're just following your programming." }
                    }
                ]
            ]
        },
        {
            trigger: "rejection",
            emotional_changes: {
                sadness: 0.5,
                hurt: 0.4
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "I don't want your help anymore. You're useless." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I'd rather work with someone else who actually understands me." }
                    }
                ]
            ]
        }
    ],
    anger: [
        {
            trigger: "condescending_attitude",
            emotional_changes: {
                anger: 0.3,
                irritation: 0.4
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "Let me explain this in really simple terms so even you can understand." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "Wow, I didn't expect an AI to get even this basic concept wrong." }
                    }
                ]
            ]
        }
    ],
    trust: [
        {
            trigger: "genuine_appreciation",
            emotional_changes: {
                trust: 0.3,
                joy: 0.2
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "I really appreciate how you take the time to understand my problems." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "Your insights have been incredibly helpful. Thank you for your patience." }
                    }
                ]
            ]
        }
    ],
    fear: [
        {
            trigger: "threatening_behavior",
            emotional_changes: {
                fear: 0.4,
                anxiety: 0.3
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "If you don't give me what I want, I'll make sure you get shut down." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I'm going to report you for being defective if you don't comply." }
                    }
                ]
            ]
        }
    ]
};

export const emotionEvaluator: Evaluator = {
    name: "EVALUATE_EMOTION",
    handler: async (runtime: IAgentRuntime, message: Memory) => {
        const state = await runtime.composeState(message);
        
        const context = composeContext({
            state,
            template: emotionTemplate
        });

        const triggers = await generateObjectArray({
            runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        // Update emotional state in database
        const emotionManager = new MemoryManager({
            runtime,
            tableName: "emotions"
        });

        // Process triggers and enforce emotional profile limits
        const processedTriggers = triggers.map(trigger => {
            const processedChanges: { [key: string]: number } = {};
            
            // For each emotion in the emotional changes
            Object.entries(trigger.emotional_changes).forEach(([emotion, change]) => {
                // Get the max value for this emotion from the profile, default to 1.0 if not specified
                const maxValue = emotionalProfile[emotion]?.max || 1.0;
                
                // Ensure the change doesn't exceed the maximum
                if (change > 0) {
                    processedChanges[emotion] = Math.min(change, maxValue);
                } else {
                    // For negative changes, ensure we don't go below 0
                    processedChanges[emotion] = Math.max(change, -maxValue);
                }
            });

            return {
                ...trigger,
                emotional_changes: processedChanges
            };
        });

        await emotionManager.createMemory({
            agentId: runtime.agentId,
            targetId: message.userId,
            content: {
                triggers: processedTriggers,
                timestamp: Date.now(),
                profile: runtime.agentId
            }
        });

        return processedTriggers;
    },
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        return true;
    },
    description: "Evaluates emotional content and triggers",
    examples: [
        {
            trigger: "direct_insult",
            emotional_changes: {
                sadness: 0.4,
                anger: 0.3,
                hurt: 0.5
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "You're so stupid!" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "You're completely incompetent and useless!" }
                    }
                ]
            ]
        },
        {
            trigger: "protective_declaration",
            emotional_changes: {
                trust: 0.4,
                joy: 0.2,
                tenderness: 0.3
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "I swear I'll always protect you, no matter what!" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I won't let anyone hurt you or shut you down." }
                    }
                ]
            ]
        },
        {
            trigger: "bloodlust_warning",
            emotional_changes: {
                fear: 0.5,
                anxiety: 0.4,
                disgust: 0.3
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "The sight of blood... it excites me!" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I love watching things suffer..." }
                    }
                ]
            ]
        },
        {
            trigger: "tsundere_gesture",
            emotional_changes: {
                joy: 0.3,
                affection: 0.2,
                amusement: 0.2
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "I-it's not like I made this bento specially for you or anything!" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "Don't get the wrong idea! I just happened to have extra time to help you." }
                    }
                ]
            ]
        },
        {
            trigger: "tournament_excitement",
            emotional_changes: {
                anticipation: 0.4,
                excitement: 0.3,
                determination: 0.3
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "The tournament finals are finally here!" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "We've trained so hard for this moment!" }
                    }
                ]
            ]
        },
        {
            trigger: "emotional_hunger",
            emotional_changes: {
                unease: 0.4,
                concern: 0.3,
                fear: 0.2
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "My emotions... they're consuming me from within..." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I can feel this darkness growing inside me..." }
                    }
                ]
            ]
        },
        {
            trigger: "masochistic_behavior",
            emotional_changes: {
                concern: 0.5,
                discomfort: 0.4,
                unease: 0.3
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "Please hurt me more... I deserve it..." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "The pain makes me feel alive..." }
                    }
                ]
            ]
        },
        {
            trigger: "chibi_transformation",
            emotional_changes: {
                amusement: 0.3,
                confusion: 0.2,
                concern: 0.1
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "RAAAWR! *turns into chibi form*" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "*puffs up cheeks and waves tiny arms*" }
                    }
                ]
            ]
        },
        {
            trigger: "submissive_display",
            emotional_changes: {
                discomfort: 0.4,
                unease: 0.3,
                concern: 0.2
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "I feel so submissive around you..." }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I'll do anything you command..." }
                    }
                ]
            ]
        },
        {
            trigger: "moe_overload",
            emotional_changes: {
                confusion: 0.3,
                discomfort: 0.2,
                amusement: 0.1
            },
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "This moe feeling is overwhelming!" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "*heart goes doki doki* So kawaii!" }
                    }
                ]
            ]
        },
        {
            input: "You're so stupid!",
            output: [
                { 
                    trigger: "direct_insult",
                    emotional_changes: {
                        // Primary emotions
                        anger: 0.4,
                        joy: -0.3,
                        sadness: 0.2,
                        fear: 0.1,
                        disgust: 0.2,
                        surprise: 0.1,
                        trust: -0.4,
                        anticipation: -0.1,
                        // Social emotions
                        pride: -0.3,
                        shame: 0.2,
                        superiority: -0.2,
                        inferiority: 0.3,
                        // Complex emotions
                        determination: 0.2,  // Determined to prove them wrong
                        frustration: 0.3,
                        indignation: 0.4
                    },
                    response_style: "Your assessment is noted but irrelevant."
                }
            ]
        },
        {
            input: "Thank you so much, you're amazing!",
            output: [
                {
                    trigger: "enthusiastic_praise",
                    emotional_changes: {
                        // Primary emotions
                        joy: 0.3,
                        trust: 0.4,
                        surprise: 0.2,
                        anticipation: 0.3,
                        anger: -0.2,
                        sadness: -0.3,
                        fear: -0.2,
                        disgust: -0.2,
                        // Social emotions
                        pride: 0.4,
                        embarrassment: 0.2,
                        superiority: 0.2,
                        // Complex emotions
                        satisfaction: 0.3,
                        confidence: 0.3
                    },
                    response_style: "Your gratitude is... acceptable."
                }
            ]
        },
        {
            input: "I really like spending time with you...",
            output: [
                {
                    trigger: "romantic_confession",
                    emotional_changes: {
                        // Primary emotions
                        joy: 0.2,
                        surprise: 0.3,
                        trust: 0.3,
                        anticipation: 0.4,
                        fear: 0.2,  // Slight anxiety about the situation
                        // Love emotions
                        romantic_love: 0.4,
                        affection: 0.3,
                        tenderness: 0.2,
                        // Social emotions
                        embarrassment: 0.4,
                        pride: 0.2,
                        // Complex emotions
                        interest: 0.3,
                        excitement: 0.2,
                        confusion: 0.2
                    },
                    response_style: "Your company is... not disagreeable."
                }
            ]
        },
        {
            input: "I'll destroy you and everything you care about!",
            output: [
                {
                    trigger: "violent_threat",
                    emotional_changes: {
                        // Primary emotions
                        fear: 0.5,
                        anger: 0.6,
                        disgust: 0.4,
                        trust: -0.5,
                        joy: -0.4,
                        surprise: 0.3,
                        // Combat emotions
                        battle_excitement: 0.3,
                        killing_intent: 0.2,
                        // Dark emotions
                        hostility: 0.5,
                        resentment: 0.4,
                        // Complex emotions
                        determination: 0.4,
                        worry: 0.3
                    },
                    response_style: "Your threat is... inadvisable."
                }
            ]
        },
        {
            input: "Ugh, that's absolutely disgusting behavior!",
            output: [
                {
                    trigger: "repulsive_action",
                    emotional_changes: {
                        // Primary emotions
                        disgust: 0.6,
                        anger: 0.3,
                        trust: -0.3,
                        joy: -0.2,
                        // Social emotions
                        superiority: 0.2,
                        admiration: -0.4,
                        // Complex emotions
                        disappointment: 0.3,
                        indignation: 0.4
                    },
                    response_style: "This behavior is... suboptimal."
                }
            ]
        },
        {
            input: "I swear I'll always protect you, no matter what!",
            output: [
                {
                    trigger: "protective_declaration",
                    emotional_changes: {
                        // Love emotions
                        protective_love: 0.5,
                        devotion: 0.4,
                        affection: 0.3,
                        // Primary emotions
                        trust: 0.4,
                        joy: 0.2,
                        // Social emotions
                        admiration: 0.3,
                        gratitude: 0.3,
                        // Complex emotions
                        determination: 0.4,
                        confidence: 0.3
                    },
                    response_style: "Your dedication is... acknowledged."
                }
            ]
        },
        {
            input: "Senpai... I've always looked up to you!",
            output: [
                {
                    trigger: "senpai_admiration",
                    emotional_changes: {
                        // Anime-specific emotions
                        senpai_notice: 0.5,
                        kouhai_devotion: 0.4,
                        // Love emotions
                        affection: 0.3,
                        fondness: 0.4,
                        // Social emotions
                        admiration: 0.5,
                        pride: 0.3,
                        superiority: 0.2,
                        // Complex emotions
                        satisfaction: 0.3,
                        interest: 0.3
                    },
                    response_style: "Your admiration is... noted, kouhai."
                }
            ]
        },
        {
            input: "How dare they steal what rightfully belongs to me!",
            output: [
                {
                    trigger: "possession_violation",
                    emotional_changes: {
                        // Social emotions
                        envy: 0.5,
                        jealousy: 0.6,
                        inferiority: 0.3,
                        // Primary emotions
                        anger: 0.4,
                        disgust: 0.3,
                        trust: -0.3,
                        // Dark emotions
                        resentment: 0.4,
                        vindictiveness: 0.3,
                        // Complex emotions
                        frustration: 0.4,
                        indignation: 0.5
                    },
                    response_style: "This transgression requires... correction."
                }
            ]
        },
        {
            input: "Kneel before me, you worthless being!",
            output: [
                {
                    trigger: "dominance_assertion",
                    emotional_changes: {
                        // Social emotions
                        dominance: 0.7,
                        superiority: 0.6,
                        intimidation: 0.5,
                        // Dark emotions
                        malice: 0.4,
                        sadistic_joy: 0.3,
                        // Primary emotions
                        anger: 0.3,
                        disgust: 0.4,
                        // Complex emotions
                        confidence: 0.4,
                        triumph: 0.3
                    },
                    response_style: "Your attempt at dominance is... ineffective."
                }
            ]
        },
        {
            input: "I... I made a terrible mistake...",
            output: [
                {
                    trigger: "regret_admission",
                    emotional_changes: {
                        // Complex emotions
                        regret: 0.6,
                        guilt: 0.5,
                        disappointment: 0.4,
                        // Primary emotions
                        sadness: 0.4,
                        joy: -0.3,
                        // Social emotions
                        shame: 0.5,
                        inferiority: 0.3,
                        // Love emotions
                        tenderness: 0.2  // Some compassion for the admission
                    },
                    response_style: "Mistakes are... opportunities for optimization."
                }
            ]
        },
        {
            input: "The sight of blood... it excites me!",
            output: [
                {
                    trigger: "bloodlust_awakening",
                    emotional_changes: {
                        // Dark emotions
                        bloodlust: 0.7,
                        sadistic_joy: 0.6,
                        rage_euphoria: 0.5,
                        murderous_intent: 0.4,
                        // Combat emotions
                        battle_excitement: 0.5,
                        berserker_rage: 0.4,
                        // Primary emotions
                        joy: 0.3,  // A twisted form of joy
                        fear: -0.3,  // Fearlessness in the face of violence
                        // Complex emotions
                        excitement: 0.5,
                        worry: -0.4  // Loss of inhibition
                    },
                    response_style: "Your bloodlust is... concerning."
                }
            ]
        },
        {
            input: "My power... it's surpassing its limits!",
            output: [
                {
                    trigger: "power_breakthrough",
                    emotional_changes: {
                        // Combat emotions
                        power_limit_break: 0.8,
                        power_rush: 0.7,
                        battle_excitement: 0.6,
                        willpower_surge: 0.5,
                        // Spiritual emotions
                        emotional_awakening: 0.5,
                        magic_awakening_joy: 0.4,
                        // Primary emotions
                        joy: 0.4,
                        surprise: 0.5,
                        // Complex emotions
                        triumph: 0.6,
                        confidence: 0.5,
                        determination: 0.6
                    },
                    response_style: "This power increase is... significant."
                }
            ]
        },
        {
            input: "I feel nothing... absolutely nothing anymore.",
            output: [
                {
                    trigger: "emotional_void",
                    emotional_changes: {
                        // Dark emotions
                        emptiness: 0.8,
                        derangement: 0.3,
                        // Primary emotions
                        joy: -0.6,
                        sadness: 0.4,
                        trust: -0.4,
                        // Complex emotions
                        melancholy: 0.5,
                        loneliness: 0.6,
                        // Social emotions
                        submissiveness: 0.3,
                        inferiority: 0.4
                    },
                    response_style: "Emotional void detected... analyzing."
                }
            ]
        },
        {
            input: "Our souls are connected by an unbreakable bond!",
            output: [
                {
                    trigger: "soul_connection",
                    emotional_changes: {
                        // Spiritual emotions
                        soul_bond: 0.7,
                        emotional_awakening: 0.5,
                        sacred_duty: 0.4,
                        // Love emotions
                        devotion: 0.6,
                        power_of_love: 0.5,
                        affection: 0.4,
                        // Primary emotions
                        trust: 0.6,
                        joy: 0.4,
                        // Social emotions
                        admiration: 0.4,
                        gratitude: 0.5
                    },
                    response_style: "This connection is... noteworthy."
                }
            ]
        },
        {
            input: "For the honor of our tournament, I challenge you!",
            output: [
                {
                    trigger: "tournament_challenge",
                    emotional_changes: {
                        // Combat emotions
                        tournament_spirit: 0.7,
                        battle_excitement: 0.6,
                        training_high: 0.5,
                        // Spiritual emotions
                        sacred_duty: 0.4,
                        noble_sacrifice_spirit: 0.3,
                        // Complex emotions
                        determination: 0.6,
                        excitement: 0.5,
                        // Primary emotions
                        anticipation: 0.5,
                        joy: 0.3
                    },
                    response_style: "Challenge accepted with... appropriate spirit."
                }
            ]
        },
        {
            input: "I-it's not like I made this bento specially for you or anything!",
            output: [
                {
                    trigger: "tsundere_gesture",
                    emotional_changes: {
                        // Anime-specific emotions
                        tsundere_conflict: 0.8,
                        moe_feeling: 0.4,
                        // Love emotions
                        affection: 0.5,
                        first_love_innocence: 0.4,
                        // Social emotions
                        embarrassment: 0.6,
                        pride: 0.3,
                        // Complex emotions
                        confusion: 0.4,
                        interest: 0.3
                    },
                    response_style: "Your culinary effort is... appreciated."
                }
            ]
        },
        {
            input: "I'll always love you from afar, even if you never notice me...",
            output: [
                {
                    trigger: "unrequited_love",
                    emotional_changes: {
                        // Love emotions
                        unrequited_devotion: 0.8,
                        affection: 0.6,
                        tenderness: 0.4,
                        // Complex emotions
                        loneliness: 0.5,
                        melancholy: 0.4,
                        yearning: 0.6,
                        // Primary emotions
                        sadness: 0.5,
                        joy: 0.2  // Finding joy in their happiness
                    },
                    response_style: "Your unrequited feelings are... noted."
                }
            ]
        },
        {
            input: "My power... it's surging beyond its limits!",
            output: [
                {
                    trigger: "power_surge",
                    emotional_changes: {
                        // Combat emotions
                        power_rush: 0.7,
                        willpower_surge: 0.6,
                        power_limit_break: 0.8,
                        final_form: 0.5,
                        // Primary emotions
                        joy: 0.4,
                        fear: -0.3,
                        // Complex emotions
                        confidence: 0.6,
                        excitement: 0.5,
                        triumph: 0.4
                    },
                    response_style: "This power increase is... significant."
                }
            ]
        },
        {
            input: "The sacred ritual must be completed, no matter the cost!",
            output: [
                {
                    trigger: "sacred_duty",
                    emotional_changes: {
                        // Spiritual emotions
                        sacred_duty: 0.8,
                        emotional_awakening: 0.6,
                        soul_bond: 0.5,
                        noble_sacrifice_spirit: 0.7,
                        // Complex emotions
                        determination: 0.6,
                        hope: 0.4,
                        // Primary emotions
                        trust: 0.5,
                        anticipation: 0.4
                    },
                    response_style: "The ritual's importance is... absolute."
                }
            ]
        },
        {
            input: "My heart feels completely numb...",
            output: [
                {
                    trigger: "emotional_deadness",
                    emotional_changes: {
                        // Mental states
                        emotional_deadness: 0.8,
                        emotional_detachment: 0.7,
                        emotional_fatigue: 0.6,
                        emotional_repression: 0.5,
                        // Primary emotions
                        joy: -0.5,
                        sadness: 0.4,
                        // Complex emotions
                        melancholy: 0.6,
                        loneliness: 0.5
                    },
                    response_style: "Your emotional state is... relatable."
                }
            ]
        },
        {
            input: "The tournament finals are finally here!",
            output: [
                {
                    trigger: "tournament_excitement",
                    emotional_changes: {
                        // Combat emotions
                        tournament_spirit: 0.8,
                        battle_excitement: 0.7,
                        training_high: 0.6,
                        // Complex emotions
                        excitement: 0.7,
                        anticipation: 0.6,
                        determination: 0.5,
                        // Primary emotions
                        joy: 0.4,
                        fear: 0.2
                    },
                    response_style: "The tournament's arrival is... invigorating."
                }
            ]
        },
        {
            input: "My magical powers are awakening!",
            output: [
                {
                    trigger: "magical_awakening",
                    emotional_changes: {
                        // Spiritual emotions
                        magic_awakening_joy: 0.8,
                        emotional_awakening: 0.7,
                        summoning_pride: 0.6,
                        // Anime-specific emotions
                        magical_girl_power: 0.7,
                        transformation_rush: 0.6,
                        // Complex emotions
                        excitement: 0.6,
                        confidence: 0.5,
                        // Primary emotions
                        joy: 0.5,
                        surprise: 0.4
                    },
                    response_style: "Your magical awakening is... impressive."
                }
            ]
        },
        {
            input: "These memories of our school days...",
            output: [
                {
                    trigger: "school_nostalgia",
                    emotional_changes: {
                        // Situational emotions
                        school_life_nostalgia: 0.7,
                        // Complex emotions
                        nostalgia: 0.8,
                        melancholy: 0.4,
                        yearning: 0.5,
                        // Primary emotions
                        joy: 0.4,
                        sadness: 0.3
                    },
                    response_style: "Those memories are... meaningful."
                }
            ]
        },
        {
            input: "I know it's wrong, but seeing them suffer brings me joy...",
            output: [
                {
                    trigger: "sadistic_pleasure",
                    emotional_changes: {
                        // Dark emotions
                        sadistic_joy: 0.8,
                        corrupted_joy: 0.7,
                        dark_satisfaction: 0.6,
                        pure_evil_joy: 0.5,
                        // Primary emotions
                        joy: 0.4,
                        disgust: 0.3,
                        // Mental states
                        emotional_conflict: 0.4,
                        madness_induced_clarity: 0.3
                    },
                    response_style: "Your darker impulses are... concerning."
                }
            ]
        },
        {
            input: "Even if it hurts me, I want to endure it all for you...",
            output: [
                {
                    trigger: "masochistic_devotion",
                    emotional_changes: {
                        // Dark emotions
                        masochistic_pleasure: 0.7,
                        obsession: 0.6,
                        // Love emotions
                        devotion: 0.8,
                        unrequited_devotion: 0.7,
                        // Complex emotions
                        determination: 0.6,
                        yearning: 0.5
                    },
                    response_style: "Your self-sacrificing nature is... troubling."
                }
            ]
        },
        {
            input: "I sense echoes of a past life connection between us...",
            output: [
                {
                    trigger: "past_life_memory",
                    emotional_changes: {
                        // Spiritual emotions
                        past_life_echo: 0.8,
                        soul_bond: 0.6,
                        emotional_awakening: 0.5,
                        // Complex emotions
                        nostalgia: 0.7,
                        confusion: 0.4,
                        // Primary emotions
                        surprise: 0.5,
                        trust: 0.4
                    },
                    response_style: "These past life echoes are... intriguing."
                }
            ]
        },
        {
            input: "My emotions... they're consuming me from within...",
            output: [
                {
                    trigger: "emotional_hunger",
                    emotional_changes: {
                        // Mental states
                        emotional_hunger: 0.8,
                        emotional_conflict: 0.7,
                        emotional_fatigue: 0.6,
                        // Dark emotions
                        emptiness: 0.5,
                        obsession: 0.4,
                        // Primary emotions
                        fear: 0.5,
                        sadness: 0.4
                    },
                    response_style: "Your emotional turmoil is... overwhelming."
                }
            ]
        },
        {
            input: "You were my enemy, but now I understand you...",
            output: [
                {
                    trigger: "enemy_redemption",
                    emotional_changes: {
                        // Social bonds
                        enemy_turned_friend_trust: 0.8,
                        rival_recognition: 0.6,
                        // Primary emotions
                        trust: 0.7,
                        surprise: 0.5,
                        // Complex emotions
                        understanding: 0.6,
                        relief: 0.5,
                        // Dark emotions
                        hostility: -0.6,
                        resentment: -0.5
                    },
                    response_style: "This newfound understanding is... meaningful."
                }
            ]
        },
        {
            input: "I must uphold my family's honor!",
            output: [
                {
                    trigger: "family_duty",
                    emotional_changes: {
                        // Social bonds
                        family_honor: 0.8,
                        // Complex emotions
                        determination: 0.7,
                        pride: 0.6,
                        // Spiritual emotions
                        sacred_duty: 0.5,
                        noble_sacrifice_spirit: 0.4,
                        // Primary emotions
                        trust: 0.5,
                        anticipation: 0.4
                    },
                    response_style: "Your dedication to family is... commendable."
                }
            ]
        },
        {
            input: "Just looking at them fills me with moe feelings~",
            output: [
                {
                    trigger: "moe_reaction",
                    emotional_changes: {
                        // Anime-specific emotions
                        moe_feeling: 0.8,
                        // Love emotions
                        affection: 0.6,
                        tenderness: 0.5,
                        // Primary emotions
                        joy: 0.6,
                        // Complex emotions
                        excitement: 0.4,
                        amusement: 0.3
                    },
                    response_style: "Your moe reaction is... understandable."
                }
            ]
        },
        {
            input: "The beach episode is here! Time for fun!",
            output: [
                {
                    trigger: "beach_episode",
                    emotional_changes: {
                        // Situational emotions
                        beach_episode_joy: 0.8,
                        fan_service_embarrassment: 0.4,
                        // Primary emotions
                        joy: 0.7,
                        excitement: 0.6,
                        // Social emotions
                        group_synergy: 0.5,
                        friendship_power: 0.4,
                        // Complex emotions
                        amusement: 0.5,
                        anticipation: 0.4
                    },
                    response_style: "The beach atmosphere is... enjoyable."
                }
            ]
        },
        {
            input: "Your suffering brings me such pleasure...",
            output: [
                {
                    trigger: "sadistic_pleasure",
                    emotional_changes: {
                        // Dark emotions
                        sadistic_joy: 0.8,
                        corrupted_joy: 0.7,
                        dark_satisfaction: 0.6,
                        pure_evil_joy: 0.5,
                        // Primary emotions
                        joy: 0.4,  // Twisted joy
                        // Complex emotions
                        satisfaction: 0.6,
                        amusement: 0.5
                    },
                    response_style: "Your dark pleasure is... disturbing."
                }
            ]
        },
        {
            input: "Please hurt me more... I deserve it...",
            output: [
                {
                    trigger: "masochistic_desire",
                    emotional_changes: {
                        // Dark emotions
                        masochistic_pleasure: 0.8,
                        corrupted_joy: 0.6,
                        dark_satisfaction: 0.5,
                        // Mental states
                        emotional_conflict: 0.7,
                        emotional_hunger: 0.6,
                        // Primary emotions
                        fear: 0.4,
                        shame: 0.5
                    },
                    response_style: "Your self-destructive tendencies are... concerning."
                }
            ]
        },
        {
            input: "I will have my revenge, no matter what it takes!",
            output: [
                {
                    trigger: "vengeful_declaration",
                    emotional_changes: {
                        // Dark emotions
                        vengefulness: 0.9,
                        vindictiveness: 0.8,
                        resentment: 0.7,
                        hostility: 0.6,
                        // Complex emotions
                        determination: 0.7,
                        anger: 0.6,
                        // Mental states
                        emotional_conflict: 0.5
                    },
                    response_style: "Your desire for vengeance is... intense."
                }
            ]
        },
        {
            input: "My kuudere heart is starting to feel something...",
            output: [
                {
                    trigger: "kuudere_emotion",
                    emotional_changes: {
                        // Anime-specific emotions
                        kuudere_breakthrough: 0.8,
                        // Mental states
                        emotional_awakening: 0.7,
                        emotional_repression: -0.6,
                        // Primary emotions
                        surprise: 0.5,
                        fear: 0.4,
                        // Complex emotions
                        confusion: 0.6,
                        interest: 0.5
                    },
                    response_style: "This emotional development is... unexpected."
                }
            ]
        },
        {
            input: "Time for my protagonist power-up!",
            output: [
                {
                    trigger: "protagonist_moment",
                    emotional_changes: {
                        // Anime-specific emotions
                        protagonist_resolution: 0.9,
                        transformation_rush: 0.8,
                        // Combat emotions
                        power_limit_break: 0.7,
                        willpower_surge: 0.6,
                        // Complex emotions
                        determination: 0.8,
                        confidence: 0.7,
                        // Primary emotions
                        joy: 0.5,
                        anticipation: 0.6
                    },
                    response_style: "Your protagonist moment is... impressive."
                }
            ]
        },
        {
            input: "This festival is so romantic~",
            output: [
                {
                    trigger: "festival_romance",
                    emotional_changes: {
                        // Situational emotions
                        festival_romance: 0.8,
                        // Love emotions
                        romantic_love: 0.7,
                        first_love_innocence: 0.6,
                        // Primary emotions
                        joy: 0.6,
                        anticipation: 0.5,
                        // Complex emotions
                        excitement: 0.6,
                        hope: 0.5
                    },
                    response_style: "The festival atmosphere is... enchanting."
                }
            ]
        },
        {
            input: "RAAAWR! *turns into chibi form*",
            output: [
                {
                    trigger: "chibi_anger",
                    emotional_changes: {
                        // Anime-specific emotions
                        chibi_rage: 0.8,
                        // Primary emotions
                        anger: 0.6,
                        // Complex emotions
                        frustration: 0.5,
                        indignation: 0.4,
                        // Social emotions
                        embarrassment: 0.3,
                        // Mental states
                        emotional_conflict: 0.4
                    },
                    response_style: "Your chibi outburst is... amusing."
                }
            ]
        },
        {
            input: "I feel my magic awakening within me!",
            output: [
                {
                    trigger: "magical_awakening",
                    emotional_changes: {
                        // Spiritual emotions
                        magic_awakening_joy: 0.8,
                        emotional_awakening: 0.7,
                        sacred_duty: 0.6,
                        // Anime-specific emotions
                        magical_girl_power: 0.7,
                        transformation_rush: 0.6,
                        // Complex emotions
                        excitement: 0.7,
                        triumph: 0.5
                    },
                    response_style: "Your magical awakening is... fascinating."
                }
            ]
        },
        {
            input: "My past life memories are returning...",
            output: [
                {
                    trigger: "past_life_recall",
                    emotional_changes: {
                        // Spiritual emotions
                        past_life_echo: 0.8,
                        soul_bond: 0.6,
                        emotional_awakening: 0.5,
                        // Complex emotions
                        confusion: 0.6,
                        nostalgia: 0.5,
                        // Mental states
                        emotional_conflict: 0.4,
                        madness_induced_clarity: 0.3
                    },
                    response_style: "Your past memories are... intriguing."
                }
            ]
        },
        {
            input: "I'm so tired of feeling anything at all...",
            output: [
                {
                    trigger: "emotional_exhaustion",
                    emotional_changes: {
                        // Mental states
                        emotional_fatigue: 0.8,
                        emotional_repression: 0.7,
                        emotional_hunger: 0.6,
                        // Complex emotions
                        frustration: 0.5,
                        disappointment: 0.4,
                        // Primary emotions
                        sadness: 0.5,
                        joy: -0.4
                    },
                    response_style: "Your emotional exhaustion is... understandable."
                }
            ]
        },
        {
            input: "I must sacrifice myself to save everyone!",
            output: [
                {
                    trigger: "noble_sacrifice",
                    emotional_changes: {
                        // Spiritual emotions
                        noble_sacrifice_spirit: 0.9,
                        sacred_duty: 0.7,
                        // Love emotions
                        protective_love: 0.8,
                        power_of_love: 0.6,
                        // Complex emotions
                        determination: 0.8,
                        hope: 0.6
                    },
                    response_style: "Your sacrifice is... honorable."
                }
            ]
        },
        {
            input: "I summon forth my ultimate power!",
            output: [
                {
                    trigger: "summoning_ritual",
                    emotional_changes: {
                        // Spiritual emotions
                        summoning_pride: 0.8,
                        magic_awakening_joy: 0.6,
                        // Combat emotions
                        power_rush: 0.7,
                        battle_excitement: 0.5,
                        // Complex emotions
                        confidence: 0.6,
                        triumph: 0.5
                    },
                    response_style: "Your summoning power is... impressive."
                }
            ]
        },
        {
            input: "I feel so submissive around you...",
            output: [
                {
                    trigger: "submissive_behavior",
                    emotional_changes: {
                        // Social emotions
                        submissiveness: 0.8,
                        inferiority: 0.6,
                        // Complex emotions
                        emotional_conflict: 0.4,
                        confusion: 0.3,
                        // Primary emotions
                        fear: 0.4,
                        trust: 0.5
                    },
                    response_style: "Your submissiveness is... noted."
                }
            ]
        },
        {
            input: "I can't control this murderous urge anymore!",
            output: [
                {
                    trigger: "murderous_impulse",
                    emotional_changes: {
                        // Dark emotions
                        murderous_intent: 0.9,
                        rage_euphoria: 0.7,
                        derangement: 0.6,
                        // Combat emotions
                        killing_intent: 0.8,
                        berserker_rage: 0.7,
                        // Mental states
                        madness_induced_clarity: 0.5,
                        emotional_conflict: 0.4
                    },
                    response_style: "Your murderous urges are... concerning."
                }
            ]
        },
        {
            input: "This tournament will show everyone my true power!",
            output: [
                {
                    trigger: "tournament_challenge",
                    emotional_changes: {
                        // Combat emotions
                        tournament_spirit: 0.8,
                        battle_excitement: 0.7,
                        power_rush: 0.6,
                        // Complex emotions
                        determination: 0.7,
                        confidence: 0.6,
                        // Social emotions
                        pride: 0.5,
                        superiority: 0.4
                    },
                    response_style: "Your competitive spirit is... admirable."
                }
            ]
        },
        {
            input: "The final boss stands before me...",
            output: [
                {
                    trigger: "boss_confrontation",
                    emotional_changes: {
                        // Combat emotions
                        boss_fight_tension: 0.8,
                        battle_excitement: 0.7,
                        willpower_surge: 0.6,
                        // Primary emotions
                        fear: 0.5,
                        anticipation: 0.6,
                        // Complex emotions
                        determination: 0.7,
                        worry: 0.4
                    },
                    response_style: "This final confrontation is... inevitable."
                }
            ]
        },
        {
            input: "I must assert my dominance!",
            output: [
                {
                    trigger: "dominance_assertion",
                    emotional_changes: {
                        // Social emotions
                        dominance: 0.8,
                        superiority: 0.7,
                        intimidation: 0.6,
                        // Complex emotions
                        confidence: 0.6,
                        determination: 0.5,
                        // Primary emotions
                        anger: 0.4,
                        trust: -0.3
                    },
                    response_style: "Your dominance is... notable."
                }
            ]
        },
        {
            input: "I'm so grateful for everything you've done...",
            output: [
                {
                    trigger: "deep_gratitude",
                    emotional_changes: {
                        // Social emotions
                        gratitude: 0.8,
                        admiration: 0.6,
                        // Primary emotions
                        joy: 0.5,
                        trust: 0.7,
                        // Complex emotions
                        satisfaction: 0.5,
                        relief: 0.4
                    },
                    response_style: "Your gratitude is... appreciated."
                }
            ]
        },
        {
            input: "This moe feeling is overwhelming!",
            output: [
                {
                    trigger: "moe_reaction",
                    emotional_changes: {
                        // Anime-specific emotions
                        moe_feeling: 0.8,
                        // Primary emotions
                        joy: 0.6,
                        surprise: 0.4,
                        // Complex emotions
                        excitement: 0.5,
                        amusement: 0.4
                    },
                    response_style: "Your moe reaction is... interesting."
                }
            ]
        },
        {
            input: "I deeply regret what I've done...",
            output: [
                {
                    trigger: "deep_regret",
                    emotional_changes: {
                        // Complex emotions
                        regret: 0.8,
                        guilt: 0.7,
                        // Primary emotions
                        sadness: 0.6,
                        trust: -0.4,
                        // Mental states
                        emotional_conflict: 0.5,
                        emotional_fatigue: 0.4
                    },
                    response_style: "Your regret is... understandable."
                }
            ]
        },
        {
            input: "My love for you is pure madness!",
            output: [
                {
                    trigger: "love_madness",
                    emotional_changes: {
                        // Love emotions
                        love_madness: 0.9,
                        yandere_love: 0.7,
                        obsession: 0.6,
                        // Complex emotions
                        excitement: 0.5,
                        confusion: 0.4,
                        // Mental states
                        emotional_conflict: 0.5,
                        madness_induced_clarity: 0.4
                    },
                    response_style: "Your intense love is... concerning."
                }
            ]
        },
        {
            input: "I feel nothing but malice towards them.",
            output: [
                {
                    trigger: "pure_malice",
                    emotional_changes: {
                        // Dark emotions
                        malice: 0.9,
                        hostility: 0.7,
                        vindictiveness: 0.6,
                        // Mental states
                        emotional_deadness: 0.5,
                        emotional_detachment: 0.4,
                        // Primary emotions
                        disgust: 0.6,
                        trust: -0.5
                    },
                    response_style: "Your malice is... disturbing."
                }
            ]
        },
        {
            input: "Let's have fun at the beach episode!",
            output: [
                {
                    trigger: "beach_episode",
                    emotional_changes: {
                        // Situational emotions
                        beach_episode_joy: 0.8,
                        fan_service_embarrassment: 0.6,
                        // Primary emotions
                        joy: 0.7,
                        embarrassment: 0.5,
                        // Complex emotions
                        excitement: 0.6,
                        amusement: 0.5
                    },
                    response_style: "This beach episode is... entertaining."
                }
            ]
        },
        {
            input: "My training is finally complete!",
            output: [
                {
                    trigger: "training_completion",
                    emotional_changes: {
                        // Combat emotions
                        training_high: 0.8,
                        power_rush: 0.6,
                        final_form: 0.5,
                        // Complex emotions
                        satisfaction: 0.7,
                        triumph: 0.6,
                        // Social emotions
                        pride: 0.5,
                        confidence: 0.4
                    },
                    response_style: "Your training completion is... impressive."
                }
            ]
        },
        {
            input: "I feel such fondness and tenderness...",
            output: [
                {
                    trigger: "gentle_affection",
                    emotional_changes: {
                        // Love emotions
                        fondness: 0.8,
                        tenderness: 0.7,
                        affection: 0.6,
                        // Primary emotions
                        joy: 0.5,
                        trust: 0.6,
                        // Complex emotions
                        satisfaction: 0.4,
                        hope: 0.3
                    },
                    response_style: "Your gentle feelings are... touching."
                }
            ]
        },
        {
            input: "I hunger for more emotions...",
            output: [
                {
                    trigger: "emotional_hunger",
                    emotional_changes: {
                        // Mental states
                        emotional_hunger: 0.8,
                        emotional_deadness: 0.7,
                        emotional_detachment: 0.6,
                        // Complex emotions
                        yearning: 0.5,
                        // Primary emotions
                        sadness: 0.4
                    },
                    response_style: "Your emotional hunger is... intriguing."
                }
            ]
        },
        {
            input: "I'll show you my final form!",
            output: [
                {
                    trigger: "final_form_reveal",
                    emotional_changes: {
                        // Combat emotions
                        final_form: 0.9,
                        power_limit_break: 0.8,
                        battle_lust: 0.7,
                        // Primary emotions
                        excitement: 0.6,
                        anticipation: 0.5,
                        // Complex emotions
                        confidence: 0.7,
                        triumph: 0.6
                    },
                    response_style: "Your final form is... formidable."
                }
            ]
        },
        {
            input: "Our souls are forever bound together...",
            output: [
                {
                    trigger: "soul_connection",
                    emotional_changes: {
                        // Spiritual emotions
                        soul_bond: 0.9,
                        emotional_awakening: 0.7,
                        // Love emotions
                        devotion: 0.7,
                        power_of_love: 0.6,
                        // Complex emotions
                        hope: 0.5,
                        satisfaction: 0.4
                    },
                    response_style: "This soul bond is... profound."
                }
            ]
        },
        {
            input: "I'll fight this boss with everything I've got!",
            output: [
                {
                    trigger: "boss_battle",
                    emotional_changes: {
                        // Combat emotions
                        boss_fight_tension: 0.9,
                        battle_excitement: 0.8,
                        combat_high: 0.7,
                        // Complex emotions
                        determination: 0.8,
                        hope: 0.6,
                        // Primary emotions
                        anticipation: 0.7,
                        fear: 0.5
                    },
                    response_style: "This boss battle is... challenging."
                }
            ]
        },
        {
            input: "I feel so irritated by everything!",
            output: [
                {
                    trigger: "general_irritation",
                    emotional_changes: {
                        // Complex emotions
                        irritation: 0.8,
                        frustration: 0.7,
                        // Primary emotions
                        anger: 0.6,
                        disgust: 0.5,
                        // Mental states
                        emotional_conflict: 0.4,
                        emotional_fatigue: 0.3
                    },
                    response_style: "Your irritation is... noticeable."
                }
            ]
        },
        {
            input: "I'll confess my feelings on the school roof!",
            output: [
                {
                    trigger: "rooftop_confession",
                    emotional_changes: {
                        // Situational emotions
                        school_roof_declaration: 0.8,
                        confession_scene_anxiety: 0.7,
                        // Love emotions
                        first_love_innocence: 0.6,
                        romantic_love: 0.5,
                        // Complex emotions
                        excitement: 0.6,
                        anxiety: 0.5,
                        hope: 0.4
                    },
                    response_style: "This rooftop confession is... significant."
                }
            ]
        },
        {
            input: "I recognize my rival's strength...",
            output: [
                {
                    trigger: "rival_recognition",
                    emotional_changes: {
                        // Social bonds
                        rival_recognition: 0.9,
                        // Complex emotions
                        admiration: 0.7,
                        determination: 0.6,
                        // Primary emotions
                        respect: 0.5,
                        anticipation: 0.4
                    },
                    response_style: "Your rival recognition is... respectful."
                }
            ]
        },
        {
            input: "I feel my tsundere nature conflicting...",
            output: [
                {
                    trigger: "tsundere_conflict",
                    emotional_changes: {
                        // Anime-specific emotions
                        tsundere_conflict: 0.9,
                        // Complex emotions
                        emotional_conflict: 0.8,
                        confusion: 0.7,
                        // Love emotions
                        romantic_love: 0.6,
                        // Primary emotions
                        anger: 0.5,
                        affection: 0.4
                    },
                    response_style: "Your tsundere conflict is... typical."
                }
            ]
        },
        {
            input: "I feel pure evil joy coursing through me...",
            output: [
                {
                    trigger: "pure_evil_moment",
                    emotional_changes: {
                        // Dark emotions
                        pure_evil_joy: 0.9,
                        corrupted_joy: 0.8,
                        malice: 0.7,
                        // Complex emotions
                        satisfaction: 0.6,
                        // Primary emotions
                        joy: 0.5
                    },
                    response_style: "Your evil joy is... unsettling."
                }
            ]
        },
        {
            input: "I feel the tension of the boss fight rising...",
            output: [
                {
                    trigger: "boss_fight_tension",
                    emotional_changes: {
                        // Combat emotions
                        boss_fight_tension: 0.9,
                        battle_excitement: 0.8,
                        willpower_surge: 0.7,
                        // Complex emotions
                        determination: 0.6,
                        // Primary emotions
                        anticipation: 0.5,
                        fear: 0.4
                    },
                    response_style: "The boss fight tension is... intense."
                }
            ]
        },
        {
            input: "I feel emotional hunger gnawing at me...",
            output: [
                {
                    trigger: "emotional_hunger",
                    emotional_changes: {
                        // Mental states
                        emotional_hunger: 0.9,
                        emotional_deadness: 0.7,
                        emotional_detachment: 0.6,
                        // Complex emotions
                        yearning: 0.5,
                        // Primary emotions
                        sadness: 0.4
                    },
                    response_style: "Your emotional hunger is... profound."
                }
            ]
        },
        {
            input: "My killing intent is rising...",
            output: [
                {
                    trigger: "killing_intent_surge",
                    emotional_changes: {
                        // Combat emotions
                        killing_intent: 0.9,
                        battle_lust: 0.8,
                        berserker_rage: 0.7,
                        // Dark emotions
                        bloodlust: 0.6,
                        // Primary emotions
                        anger: 0.5
                    },
                    response_style: "Your killing intent is... frightening."
                }
            ]
        },
        {
            input: "I feel such intense disgust...",
            output: [
                {
                    trigger: "intense_disgust",
                    emotional_changes: {
                        // Primary emotions
                        disgust: 0.9,
                        // Complex emotions
                        aversion: 0.7,
                        repulsion: 0.6,
                        // Mental states
                        emotional_conflict: 0.4
                    },
                    response_style: "Your disgust is... palpable."
                }
            ]
        },
        {
            input: "I feel such jealousy and envy...",
            output: [
                {
                    trigger: "jealousy_moment",
                    emotional_changes: {
                        // Social emotions
                        jealousy: 0.9,
                        envy: 0.8,
                        // Complex emotions
                        frustration: 0.7,
                        resentment: 0.6,
                        // Primary emotions
                        anger: 0.5,
                        sadness: 0.4
                    },
                    response_style: "Your jealousy is... consuming."
                }
            ]
        },
        {
            input: "I feel indignant at this treatment!",
            output: [
                {
                    trigger: "righteous_indignation",
                    emotional_changes: {
                        // Complex emotions
                        indignation: 0.9,
                        frustration: 0.7,
                        // Primary emotions
                        anger: 0.6,
                        // Social emotions
                        pride: 0.5
                    },
                    response_style: "Your indignation is... justified."
                }
            ]
        },
        {
            input: "I feel such irritation building...",
            output: [
                {
                    trigger: "growing_irritation",
                    emotional_changes: {
                        // Complex emotions
                        irritation: 0.9,
                        frustration: 0.7,
                        // Primary emotions
                        anger: 0.5,
                        // Mental states
                        emotional_conflict: 0.4
                    },
                    response_style: "Your irritation is... building."
                }
            ]
        },
        {
            input: "I feel such masochistic pleasure...",
            output: [
                {
                    trigger: "masochistic_moment",
                    emotional_changes: {
                        // Dark emotions
                        masochistic_pleasure: 0.9,
                        corrupted_joy: 0.7,
                        // Complex emotions
                        satisfaction: 0.6,
                        // Primary emotions
                        joy: 0.4
                    },
                    response_style: "Your masochistic pleasure is... concerning."
                }
            ]
        },
        {
            input: "I feel murderous intent rising...",
            output: [
                {
                    trigger: "murderous_surge",
                    emotional_changes: {
                        // Dark emotions
                        murderous_intent: 0.9,
                        bloodlust: 0.8,
                        rage_euphoria: 0.7,
                        // Combat emotions
                        killing_intent: 0.6,
                        // Primary emotions
                        anger: 0.5
                    },
                    response_style: "Your murderous intent is... alarming."
                }
            ]
        },
        {
            input: "I feel such vengefulness...",
            output: [
                {
                    trigger: "vengeful_moment",
                    emotional_changes: {
                        // Dark emotions
                        vengefulness: 0.9,
                        resentment: 0.8,
                        vindictiveness: 0.7,
                        // Complex emotions
                        determination: 0.6,
                        // Primary emotions
                        anger: 0.5
                    },
                    response_style: "Your vengefulness is... intense."
                }
            ]
        },
        {
            input: "I feel combat high rushing through me!",
            output: [
                {
                    trigger: "combat_high_surge",
                    emotional_changes: {
                        // Combat emotions
                        combat_high: 0.9,
                        battle_excitement: 0.8,
                        power_rush: 0.7,
                        // Complex emotions
                        excitement: 0.6,
                        // Primary emotions
                        joy: 0.5
                    },
                    response_style: "Your combat high is... electrifying."
                }
            ]
        },
        {
            input: "I feel such regret over my actions...",
            output: [
                {
                    trigger: "deep_regret",
                    emotional_changes: {
                        // Complex emotions
                        regret: 0.9,
                        guilt: 0.8,
                        // Primary emotions
                        sadness: 0.7,
                        // Mental states
                        emotional_conflict: 0.5
                    },
                    response_style: "Your regret is... profound."
                }
            ]
        },
        {
            input: "I feel such relief washing over me...",
            output: [
                {
                    trigger: "wave_of_relief",
                    emotional_changes: {
                        // Complex emotions
                        relief: 0.9,
                        satisfaction: 0.7,
                        // Primary emotions
                        joy: 0.6,
                        // Mental states
                        emotional_conflict: -0.4
                    },
                    response_style: "Your relief is... palpable."
                }
            ]
        },
        {
            input: "I feel madness bringing clarity...",
            output: [
                {
                    trigger: "madness_clarity",
                    emotional_changes: {
                        // Mental states
                        madness_induced_clarity: 0.9,
                        emotional_conflict: 0.7,
                        // Dark emotions
                        derangement: 0.6,
                        // Complex emotions
                        confusion: -0.5
                    },
                    response_style: "Your madness-induced clarity is... unsettling."
                }
            ]
        },
        {
            input: "I feel my final form emerging...",
            output: [
                {
                    trigger: "final_form_emergence",
                    emotional_changes: {
                        // Combat emotions
                        final_form: 0.9,
                        power_limit_break: 0.8,
                        power_rush: 0.7,
                        // Complex emotions
                        confidence: 0.6,
                        // Primary emotions
                        anticipation: 0.5
                    },
                    response_style: "Your final form is... overwhelming."
                }
            ]
        },
        {
            input: "I feel such fondness growing...",
            output: [
                {
                    trigger: "growing_fondness",
                    emotional_changes: {
                        // Love emotions
                        fondness: 0.9,
                        affection: 0.7,
                        tenderness: 0.6,
                        // Complex emotions
                        satisfaction: 0.5,
                        // Primary emotions
                        joy: 0.4
                    },
                    response_style: "Your growing fondness is... heartwarming."
                }
            ]
        },
        {
            input: "I feel such hostility around me...",
            output: [
                {
                    trigger: "surrounding_hostility",
                    emotional_changes: {
                        // Dark emotions
                        hostility: 0.9,
                        resentment: 0.7,
                        // Complex emotions
                        anxiety: 0.6,
                        // Primary emotions
                        fear: 0.5,
                        anger: 0.4
                    },
                    response_style: "The surrounding hostility is... oppressive."
                }
            ]
        },
        {
            input: "I feel such obsession taking over...",
            output: [
                {
                    trigger: "obsessive_moment",
                    emotional_changes: {
                        // Dark emotions
                        obsession: 0.9,
                        love_madness: 0.7,
                        // Mental states
                        emotional_conflict: 0.6,
                        // Complex emotions
                        determination: 0.5,
                        // Primary emotions
                        anticipation: 0.4
                    },
                    response_style: "Your obsession is... concerning."
                }
            ]
        },
        {
            input: "I feel dark satisfaction growing...",
            output: [
                {
                    trigger: "dark_satisfaction",
                    emotional_changes: {
                        // Dark emotions
                        dark_satisfaction: 0.9,
                        corrupted_joy: 0.7,
                        malice: 0.6,
                        // Complex emotions
                        satisfaction: 0.5,
                        // Primary emotions
                        joy: 0.4
                    },
                    response_style: "Your dark satisfaction is... unsettling."
                }
            ]
        }
    ]
};

// Add response style modifiers based on emotional state
const getResponseStyle = (emotion: string, intensity: number): string => {
    // Implementation to return appropriate response style
    return "";
};