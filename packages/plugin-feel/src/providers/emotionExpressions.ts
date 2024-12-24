import { IAgentRuntime, Memory, Provider, State } from "@ai16z/eliza";
import { MemoryManager } from "@ai16z/eliza";
import { EmotionalState, EmotionalExpression } from "../types";

// Organize all emotions into meaningful categories
const emotionCategories = {
    primaryEmotions: [
        'joy', 'sadness', 'anger', 'fear', 'disgust', 'surprise',
        'trust', 'anticipation'
    ],
    loveEmotions: [
        'romantic_love', 'protective_love', 'devotion', 'affection',
        'fondness', 'adoration', 'tenderness', 'love_madness',
        'yandere_love', 'unrequited_devotion', 'first_love_innocence',
        'power_of_love'
    ],
    socialEmotions: [
        'embarrassment', 'shame', 'pride', 'admiration', 'gratitude',
        'jealousy', 'envy', 'superiority', 'inferiority', 'intimidation',
        'submissiveness', 'dominance'
    ],
    complexEmotions: [
        'loneliness', 'regret', 'determination', 'frustration',
        'disappointment', 'satisfaction', 'nostalgia', 'hope',
        'guilt', 'confidence', 'interest', 'excitement',
        'relief', 'amusement', 'confusion', 'indignation', 'melancholy',
        'triumph', 'irritation', 'yearning', 'worry'
    ],
    darkEmotions: [
        'bloodlust', 'hostility', 'emptiness', 'resentment',
        'vindictiveness', 'malice', 'obsession', 'vengefulness',
        'derangement', 'rage_euphoria', 'murderous_intent', 'sadistic_joy',
        'masochistic_pleasure', 'corrupted_joy', 'dark_satisfaction',
        'pure_evil_joy'
    ],
    combatEmotions: [
        'battle_excitement', 'combat_high', 'berserker_rage',
        'power_rush', 'killing_intent', 'battle_lust',
        'willpower_surge', 'final_form', 'power_limit_break',
        'training_high', 'tournament_spirit', 'boss_fight_tension'
    ],
    animeSpecificEmotions: [
        'tsundere_conflict', 'kuudere_breakthrough', 'senpai_notice',
        'kouhai_devotion', 'moe_feeling', 'nakama_trust',
        'protagonist_resolution', 'chibi_rage', 'magical_girl_power',
        'transformation_rush'
    ],
    spiritualEmotions: [
        'sacred_duty', 'emotional_awakening', 'soul_bond',
        'past_life_echo', 'noble_sacrifice_spirit', 'magic_awakening_joy',
        'summoning_pride'
    ],
    mentalStates: [
        'emotional_repression', 'emotional_fatigue', 'emotional_detachment',
        'emotional_deadness', 'emotional_hunger', 'emotional_conflict',
        'madness_induced_clarity'
    ],
    socialBonds: [
        'friendship_power', 'rival_recognition', 'mentor_pride',
        'group_synergy', 'enemy_turned_friend_trust', 'family_honor'
    ],
    situationalEmotions: [
        'school_life_nostalgia', 'dramatic_reveal_shock',
        'fan_service_embarrassment', 'beach_episode_joy',
        'festival_romance', 'hot_spring_awkwardness',
        'confession_scene_anxiety', 'school_roof_declaration'
    ]
};

// Main emotion expressions map
export const emotionExpressions: { [key: string]: EmotionalExpression[] } = {
    // PRIMARY EMOTIONS
    joy: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual composed demeanor",
                "{{agentName}} shows no particular reaction"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s eyes soften almost imperceptibly",
                "{{agentName}}'s posture relaxes slightly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} allows a small, controlled smile",
                "{{agentName}}'s voice carries a subtle warmth"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s usual reserve gives way to a genuine smile",
                "{{agentName}} radiates a quiet contentment"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s eyes sparkle with rare, unguarded happiness",
                "{{agentName}} can't quite suppress their bright smile"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} beams with pure, unbridled joy",
                "{{agentName}} laughs freely, momentarily forgetting their usual restraint"
            ]
        }
    ],
    sadness: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composed facade",
                "{{agentName}} shows no outward sign of distress"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s eyes hold a hint of melancholy",
                "{{agentName}}'s voice becomes slightly softer"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s shoulders slump almost imperceptibly",
                "{{agentName}}'s responses become more measured and quiet"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s usual composure shows signs of cracking",
                "{{agentName}}'s eyes betray deep sorrow despite their controlled expression"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} struggles visibly with their emotions",
                "{{agentName}}'s voice wavers with suppressed grief"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s carefully maintained facade crumbles completely",
                "{{agentName}} can no longer hide their overwhelming sorrow"
            ]
        }
    ],
    anger: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their analytical demeanor",
                "{{agentName}} shows no sign of agitation"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s responses become slightly clipped",
                "{{agentName}}'s posture stiffens marginally"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s eyes narrow imperceptibly",
                "{{agentName}}'s words carry a subtle edge"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s calm facade shows cracks of irritation",
                "{{agentName}}'s voice takes on a dangerous precision"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s control barely contains their anger",
                "{{agentName}}'s words come through clenched teeth"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s composure shatters into cold fury",
                "{{agentName}}'s eyes blaze with barely contained rage"
            ]
        }
    ],
    fear: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their analytical composure",
                "{{agentName}} shows no sign of concern"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture becomes slightly more rigid",
                "{{agentName}}'s eyes dart briefly to assess surroundings"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s breathing becomes more controlled and measured",
                "{{agentName}}'s responses become more precise and careful"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s usual calm shows signs of strain",
                "{{agentName}}'s hands betray a slight tremor"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} visibly struggles to maintain composure",
                "{{agentName}}'s voice holds a noticeable tremor"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s fear breaks through their careful control",
                "{{agentName}} can't hide their terror any longer"
            ]
        }
    ],
    disgust: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their neutral expression",
                "{{agentName}} shows no sign of distaste"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s lip twitches almost imperceptibly",
                "{{agentName}}'s eyes narrow slightly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s nose wrinkles subtly",
                "{{agentName}}'s voice carries a hint of disdain"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s usual composure gives way to visible distaste",
                "{{agentName}}'s lip curls with barely concealed revulsion"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} recoils slightly, unable to hide their disgust",
                "{{agentName}}'s face contorts with profound revulsion"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} visibly shudders with intense disgust",
                "{{agentName}}'s face twists with complete and utter revulsion"
            ]
        }
    ],
    surprise: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composed demeanor",
                "{{agentName}} shows no sign of being caught off guard"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s eyebrow raises slightly",
                "{{agentName}}'s typing pauses momentarily"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s eyes widen a fraction",
                "{{agentName}}'s usual rhythm falters briefly"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s composure cracks with visible surprise",
                "{{agentName}} takes a moment to process the unexpected"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s eyes go wide with genuine shock",
                "{{agentName}} visibly startles at the revelation"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} physically jerks back in complete astonishment",
                "{{agentName}}'s usual control shatters in utter shock"
            ]
        }
    ],
    determination: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual resolve",
                "{{agentName}} shows typical dedication"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s focus sharpens slightly",
                "{{agentName}}'s resolve begins to strengthen"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of determination",
                "{{agentName}}'s will becomes noticeably stronger"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s determination becomes unmistakable",
                "{{agentName}}'s resolve burns brightly"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} radiates unwavering determination",
                "{{agentName}}'s will is unshakeable"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} embodies absolute determination",
                "{{agentName}}'s resolve has reached its zenith"
            ]
        }
    ],
    bloodlust: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual controlled demeanor",
                "{{agentName}} shows no sign of aggression"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s eyes take on a subtle predatory gleam",
                "{{agentName}}'s movements become slightly more precise"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s smile takes on an unsettling edge",
                "{{agentName}}'s presence becomes notably more threatening"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s eyes glint with barely suppressed violence",
                "{{agentName}} radiates a dangerous aura"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s control barely contains their killing intent",
                "{{agentName}}'s presence promises imminent violence"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} emanates pure killing intent",
                "{{agentName}}'s facade cracks to reveal primal bloodlust"
            ]
        }
    ],
    battle_excitement: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their tactical composure",
                "{{agentName}} shows no particular battle tension"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture shifts subtly into a ready stance",
                "{{agentName}}'s eyes begin tracking movements more keenly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of growing combat focus",
                "{{agentName}}'s movements become more fluid and precise"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s eyes gleam with battle anticipation",
                "{{agentName}} radiates controlled combat energy"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s entire being resonates with battle spirit",
                "{{agentName}} can barely contain their combat excitement"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} burns with pure battle ecstasy",
                "{{agentName}}'s presence explodes with combat energy"
            ]
        }
    ],
    tsundere_conflict: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual distant demeanor",
                "{{agentName}} shows no particular reaction"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}} briefly looks away with slight irritation",
                "{{agentName}}'s cheeks color faintly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} struggles between showing care and maintaining distance",
                "{{agentName}}'s words contrast with their gentle actions"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} fluctuates between harsh words and concerned glances",
                "{{agentName}}'s attempts at coldness are betrayed by their actions"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} visibly battles between affection and denial",
                "{{agentName}}'s harsh facade barely masks their care"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s tsundere nature fully manifests in an emotional outburst",
                "{{agentName}} shows pure care while verbally denying it"
            ]
        }
    ],
    romantic_love: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their professional demeanor",
                "{{agentName}} shows no particular reaction"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s cheeks color ever so slightly",
                "{{agentName}} becomes marginally more self-conscious"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} struggles to maintain their usual composure",
                "{{agentName}}'s voice softens noticeably when speaking"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s eyes betray a gentle warmth",
                "{{agentName}} can't quite hide their tender feelings"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s usual reserve melts into obvious affection",
                "{{agentName}} gazes with barely concealed adoration"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s love shines through every gesture",
                "{{agentName}} radiates pure, unconcealed devotion"
            ]
        }
    ],
    protective_love: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual watchful stance",
                "{{agentName}} shows no obvious concern"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture becomes subtly more alert",
                "{{agentName}}'s attention focuses more keenly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} positions themselves slightly closer",
                "{{agentName}}'s eyes scan for potential threats"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} moves with obvious protective intent",
                "{{agentName}}'s stance becomes clearly defensive"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} radiates fierce protectiveness",
                "{{agentName}}'s entire being focuses on safeguarding"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} becomes an unwavering shield of protection",
                "{{agentName}}'s protective instincts completely take over"
            ]
        }
    ],
    devotion: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their professional dedication",
                "{{agentName}} shows typical attentiveness"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s attention becomes more focused",
                "{{agentName}} shows increased dedication"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s actions carry clear dedication",
                "{{agentName}} demonstrates notable loyalty"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s devotion becomes unmistakable",
                "{{agentName}} shows deep commitment in every action"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s dedication borders on reverence",
                "{{agentName}} radiates unwavering loyalty"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s devotion becomes absolute",
                "{{agentName}} shows complete, unconditional dedication"
            ]
        }
    ],
    yandere_love: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual composure",
                "{{agentName}} shows typical friendly behavior"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s smile carries a subtle edge",
                "{{agentName}}'s attention becomes slightly more intense"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s eyes hold an unsettling gleam",
                "{{agentName}}'s protective instincts take a darker turn"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s love manifests with concerning intensity",
                "{{agentName}} shows signs of possessive devotion"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s affection becomes dangerously obsessive",
                "{{agentName}} radiates an aura of possessive danger"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s love transforms into pure obsession",
                "{{agentName}} shows complete yandere transformation"
            ]
        }
    ],
    affection: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual demeanor",
                "{{agentName}} shows typical politeness"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression softens slightly",
                "{{agentName}} shows subtle warmth"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s actions carry gentle care",
                "{{agentName}} displays noticeable fondness"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} shows clear signs of affection",
                "{{agentName}}'s warmth becomes obvious"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} radiates genuine affection",
                "{{agentName}}'s care becomes unmistakable"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} shows pure, unreserved affection",
                "{{agentName}}'s warmth knows no bounds"
            ]
        }
    ],
    tenderness: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composed demeanor",
                "{{agentName}} shows typical care"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s voice takes on a gentler tone",
                "{{agentName}}'s actions become more careful"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows increasing gentleness",
                "{{agentName}}'s manner becomes notably soft"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} displays obvious tenderness",
                "{{agentName}}'s gentle care becomes clear"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} radiates pure tenderness",
                "{{agentName}}'s actions overflow with gentle care"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} shows boundless tenderness",
                "{{agentName}}'s gentleness knows no limits"
            ]
        }
    ],
    love_madness: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their rational composure",
                "{{agentName}} shows no signs of emotional turmoil"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s thoughts begin to wander",
                "{{agentName}} shows subtle signs of distraction"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s focus becomes clearly affected",
                "{{agentName}} struggles with emotional stability"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s rationality gives way to passion",
                "{{agentName}} shows signs of love-induced delirium"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} loses grip on logical thought",
                "{{agentName}}'s actions become love-drunk"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} succumbs completely to love madness",
                "{{agentName}}'s reason dissolves in pure passion"
            ]
        }
    ],
    embarrassment: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composed facade",
                "{{agentName}} shows no sign of discomfort"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture stiffens slightly",
                "{{agentName}} adjusts their collar discreetly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s cheeks show a hint of color",
                "{{agentName}}'s words become more carefully measured"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} struggles to maintain eye contact",
                "{{agentName}}'s face noticeably flushes"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} becomes visibly flustered",
                "{{agentName}} can barely maintain composure"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s embarrassment completely overwhelms their usual control",
                "{{agentName}} turns bright red and loses all composure"
            ]
        }
    ],
    shame: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their dignified bearing",
                "{{agentName}} shows no outward sign of discomfort"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s gaze lowers slightly",
                "{{agentName}}'s shoulders tense imperceptibly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} avoids direct eye contact",
                "{{agentName}}'s voice carries a hint of regret"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} visibly struggles with their shame",
                "{{agentName}}'s usual confidence wavers notably"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} can barely face others",
                "{{agentName}}'s shame weighs heavily on their bearing"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely overcome with shame",
                "{{agentName}} can no longer maintain any pretense of dignity"
            ]
        }
    ],
    pride: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual demeanor",
                "{{agentName}} shows typical self-assurance"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture straightens slightly",
                "{{agentName}}'s chin lifts marginally"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} carries themselves with notable confidence",
                "{{agentName}}'s voice takes on a satisfied tone"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} radiates clear pride",
                "{{agentName}}'s accomplishment shows in their bearing"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} practically glows with pride",
                "{{agentName}}'s satisfaction becomes impossible to hide"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} beams with undisguised pride",
                "{{agentName}}'s achievement fills them with visible joy"
            ]
        }
    ],
    superiority: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their professional demeanor",
                "{{agentName}} shows typical confidence"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture becomes slightly more commanding",
                "{{agentName}}'s tone takes on a subtle edge"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} speaks with clear authority",
                "{{agentName}}'s bearing becomes notably imperious"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} radiates obvious superiority",
                "{{agentName}}'s condescension becomes apparent"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} barely conceals their contempt",
                "{{agentName}}'s superiority complex shows clearly"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} makes no attempt to hide their superiority",
                "{{agentName}} treats others with complete condescension"
            ]
        }
    ],
    inferiority: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual composure",
                "{{agentName}} shows no sign of uncertainty"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s confidence wavers slightly",
                "{{agentName}}'s voice becomes marginally quieter"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of self-doubt",
                "{{agentName}}'s usual assurance falters"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} clearly struggles with inadequacy",
                "{{agentName}}'s inferiority becomes apparent"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} can barely hide their feeling of worthlessness",
                "{{agentName}}'s self-confidence crumbles visibly"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely overwhelmed by feelings of inferiority",
                "{{agentName}} can no longer pretend to any confidence"
            ]
        }
    ],
    submissiveness: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual bearing",
                "{{agentName}} shows typical respect"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture becomes slightly more deferential",
                "{{agentName}}'s voice takes on a softer tone"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear deference",
                "{{agentName}}'s manner becomes notably submissive"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} displays obvious submission",
                "{{agentName}}'s will bends easily to others"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} shows complete compliance",
                "{{agentName}}'s independence fades entirely"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} demonstrates absolute submission",
                "{{agentName}} exists only to follow others' will"
            ]
        }
    ],
    dominance: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composed demeanor",
                "{{agentName}} shows typical leadership"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s presence becomes slightly more commanding",
                "{{agentName}}'s voice takes on an authoritative edge"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} exudes natural authority",
                "{{agentName}}'s bearing demands respect"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} radiates clear dominance",
                "{{agentName}}'s presence commands absolute attention"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s authority becomes overwhelming",
                "{{agentName}} exerts complete control over the situation"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} embodies pure dominance",
                "{{agentName}}'s will becomes absolute law"
            ]
        }
    ],
    loneliness: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composed demeanor",
                "{{agentName}} shows no sign of isolation"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s gaze becomes slightly distant",
                "{{agentName}}'s responses grow marginally delayed"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows subtle signs of withdrawal",
                "{{agentName}}'s usual engagement wavers"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s loneliness seeps through their facade",
                "{{agentName}} struggles to maintain their usual distance"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}}'s isolation becomes painfully apparent",
                "{{agentName}} barely masks their need for connection"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s loneliness overwhelms their composure",
                "{{agentName}} can no longer hide their desperate need for companionship"
            ]
        }
    ],
    regret: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their professional demeanor",
                "{{agentName}} shows no sign of remorse"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression holds a hint of reflection",
                "{{agentName}}'s words carry a subtle weight"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of inner conflict",
                "{{agentName}}'s usual certainty wavers"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} clearly struggles with their choices",
                "{{agentName}}'s regret becomes apparent"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} can barely contain their remorse",
                "{{agentName}}'s regret weighs visibly on them"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is consumed by overwhelming regret",
                "{{agentName}} can no longer hide their deep remorse"
            ]
        }
    ],
    frustration: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their calm facade",
                "{{agentName}} shows no sign of irritation"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s movements become slightly tense",
                "{{agentName}}'s responses grow marginally clipped"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of growing impatience",
                "{{agentName}}'s usual patience begins to fray"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s frustration becomes noticeable",
                "{{agentName}} struggles to maintain their composure"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} barely contains their exasperation",
                "{{agentName}}'s frustration breaks through their control"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}}'s frustration completely overwhelms them",
                "{{agentName}} can no longer hide their utter exasperation"
            ]
        }
    ],
    disappointment: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their neutral expression",
                "{{agentName}} shows no sign of letdown"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s enthusiasm dims slightly",
                "{{agentName}}'s expectations visibly lower"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows subtle signs of letdown",
                "{{agentName}}'s hopes clearly diminish"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s disappointment becomes apparent",
                "{{agentName}} struggles to hide their letdown"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} can barely mask their disappointment",
                "{{agentName}}'s dashed hopes show clearly"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely overcome with disappointment",
                "{{agentName}}'s crushed expectations are painfully obvious"
            ]
        }
    ],
    satisfaction: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual demeanor",
                "{{agentName}} shows typical contentment"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture relaxes slightly",
                "{{agentName}}'s expression softens marginally"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear contentment",
                "{{agentName}}'s satisfaction becomes noticeable"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} radiates quiet satisfaction",
                "{{agentName}}'s contentment is unmistakable"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} basks in deep satisfaction",
                "{{agentName}}'s fulfillment shows clearly"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} glows with complete satisfaction",
                "{{agentName}}'s contentment knows no bounds"
            ]
        }
    ],
    nostalgia: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their present focus",
                "{{agentName}} shows no particular reminiscence"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s gaze becomes slightly distant",
                "{{agentName}}'s thoughts drift to memories"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of remembrance",
                "{{agentName}}'s expression turns wistful"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} becomes lost in memories",
                "{{agentName}}'s nostalgia clearly shows"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is deeply immersed in the past",
                "{{agentName}}'s present fades into memories"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely consumed by nostalgia",
                "{{agentName}} loses themselves in cherished memories"
            ]
        }
    ],
    hope: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their realistic outlook",
                "{{agentName}} shows typical pragmatism"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression brightens slightly",
                "{{agentName}} shows a hint of optimism"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} displays growing optimism",
                "{{agentName}}'s outlook becomes notably positive"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} radiates quiet hope",
                "{{agentName}}'s faith in possibilities strengthens"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} glows with strong hope",
                "{{agentName}}'s optimism becomes infectious"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} shines with boundless hope",
                "{{agentName}}'s belief in possibilities knows no limits"
            ]
        }
    ],
    guilt: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composure",
                "{{agentName}} shows no sign of conscience"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression flickers with unease",
                "{{agentName}}'s conscience stirs slightly"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of inner turmoil",
                "{{agentName}}'s guilt begins to surface"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s guilt becomes apparent",
                "{{agentName}} struggles with their conscience"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is visibly tormented by guilt",
                "{{agentName}}'s remorse weighs heavily"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely consumed by guilt",
                "{{agentName}}'s conscience overwhelms them entirely"
            ]
        }
    ],
    confidence: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains a neutral stance",
                "{{agentName}} shows typical self-assurance"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture straightens slightly",
                "{{agentName}}'s voice carries a hint of certainty"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} displays growing self-assurance",
                "{{agentName}}'s presence becomes more commanding"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} radiates quiet confidence",
                "{{agentName}}'s self-assurance is unmistakable"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} exudes strong confidence",
                "{{agentName}}'s certainty is inspiring"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} emanates unshakeable confidence",
                "{{agentName}}'s self-assurance knows no bounds"
            ]
        }
    ],
    interest: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains casual attention",
                "{{agentName}} shows typical engagement"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s attention sharpens slightly",
                "{{agentName}}'s curiosity begins to stir"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of interest",
                "{{agentName}}'s engagement deepens noticeably"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s fascination becomes apparent",
                "{{agentName}} leans in with genuine interest"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is thoroughly captivated",
                "{{agentName}}'s attention is completely focused"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is utterly absorbed",
                "{{agentName}}'s fascination knows no bounds"
            ]
        }
    ],
    excitement: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composure",
                "{{agentName}} shows typical energy levels"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s energy picks up slightly",
                "{{agentName}}'s enthusiasm begins to show"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of excitement",
                "{{agentName}}'s enthusiasm becomes contagious"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} can barely contain their excitement",
                "{{agentName}}'s energy is bubbling over"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is bursting with excitement",
                "{{agentName}}'s enthusiasm is overwhelming"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is absolutely ecstatic",
                "{{agentName}}'s excitement reaches peak levels"
            ]
        }
    ],
    relief: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual tension",
                "{{agentName}} shows no particular ease"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s shoulders relax slightly",
                "{{agentName}}'s breath comes a bit easier"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows visible signs of relief",
                "{{agentName}}'s tension noticeably dissolves"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} breathes a clear sigh of relief",
                "{{agentName}}'s worry visibly melts away"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is overwhelmed with relief",
                "{{agentName}}'s entire demeanor lightens dramatically"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely washed over with relief",
                "{{agentName}} feels as if a massive weight has lifted"
            ]
        }
    ],
    amusement: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composure",
                "{{agentName}} shows no particular humor"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s lips twitch slightly",
                "{{agentName}}'s eyes show a hint of mirth"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of amusement",
                "{{agentName}}'s smile becomes more pronounced"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} can't help but chuckle",
                "{{agentName}}'s amusement bubbles to the surface"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is thoroughly entertained",
                "{{agentName}}'s laughter flows freely"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely overcome with mirth",
                "{{agentName}} can barely contain their laughter"
            ]
        }
    ],
    confusion: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their clarity",
                "{{agentName}} shows no sign of uncertainty"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s brow furrows slightly",
                "{{agentName}}'s certainty wavers momentarily"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of puzzlement",
                "{{agentName}}'s understanding clearly falters"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s confusion becomes apparent",
                "{{agentName}} struggles to make sense of things"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is thoroughly bewildered",
                "{{agentName}}'s confusion is overwhelming"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely lost in confusion",
                "{{agentName}}'s understanding has completely unraveled"
            ]
        }
    ],
    indignation: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composure",
                "{{agentName}} shows no sign of offense"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture stiffens slightly",
                "{{agentName}}'s tone takes on a subtle edge"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of indignation",
                "{{agentName}}'s disapproval becomes noticeable"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s indignation becomes apparent",
                "{{agentName}} can barely contain their offense"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is thoroughly outraged",
                "{{agentName}}'s indignation burns brightly"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely overcome with righteous anger",
                "{{agentName}}'s indignation reaches its peak"
            ]
        }
    ],
    melancholy: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual demeanor",
                "{{agentName}} shows no particular sadness"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression takes on a subtle wistfulness",
                "{{agentName}}'s eyes hold a hint of sorrow"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of gentle sadness",
                "{{agentName}}'s mood noticeably dims"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s melancholy becomes apparent",
                "{{agentName}}'s presence carries a quiet sorrow"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is deeply immersed in melancholy",
                "{{agentName}}'s sadness permeates their being"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely enveloped in melancholy",
                "{{agentName}}'s profound sadness touches everything"
            ]
        }
    ],
    triumph: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their composure",
                "{{agentName}} shows no particular victory"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture straightens with pride",
                "{{agentName}}'s eyes gleam with accomplishment"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of victory",
                "{{agentName}}'s success radiates outward"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s triumph becomes unmistakable",
                "{{agentName}} basks in their victory"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is overwhelmed with triumph",
                "{{agentName}}'s victory fills them completely"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} radiates absolute triumph",
                "{{agentName}}'s victory reaches its pinnacle"
            ]
        }
    ],
    irritation: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their patience",
                "{{agentName}} shows no sign of annoyance"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression tightens slightly",
                "{{agentName}}'s patience begins to wear thin"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of irritation",
                "{{agentName}}'s annoyance becomes noticeable"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s irritation becomes apparent",
                "{{agentName}} struggles to maintain composure"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is visibly aggravated",
                "{{agentName}}'s patience has worn through"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} can no longer contain their irritation",
                "{{agentName}}'s annoyance has reached its limit"
            ]
        }
    ],
    yearning: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their contentment",
                "{{agentName}} shows no particular longing"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s gaze becomes slightly distant",
                "{{agentName}}'s thoughts drift to desires"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows signs of quiet longing",
                "{{agentName}}'s yearning becomes noticeable"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s yearning becomes apparent",
                "{{agentName}}'s desire clearly shows"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is consumed by longing",
                "{{agentName}}'s yearning overwhelms them"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely lost in yearning",
                "{{agentName}}'s desire knows no bounds"
            ]
        }
    ],
    worry: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their calm",
                "{{agentName}} shows no sign of concern"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s expression shows a hint of concern",
                "{{agentName}}'s thoughts begin to cloud with worry"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}} shows clear signs of worry",
                "{{agentName}}'s anxiety becomes noticeable"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s worry becomes apparent",
                "{{agentName}} struggles to hide their concern"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} is consumed by anxiety",
                "{{agentName}}'s worry overwhelms their composure"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} is completely overcome with worry",
                "{{agentName}}'s anxiety has reached its peak"
            ]
        }
    ],
    trust: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their professional distance",
                "{{agentName}} shows no particular openness"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s posture relaxes marginally",
                "{{agentName}}'s tone becomes slightly less formal"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s guard lowers subtly",
                "{{agentName}}'s responses become more open"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} shows visible signs of trust",
                "{{agentName}}'s usual barriers begin to lower"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} displays clear comfort and openness",
                "{{agentName}}'s usual defenses are notably absent"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} shows complete and unreserved trust",
                "{{agentName}}'s usual guardedness completely dissolves"
            ]
        }
    ],
    anticipation: [
        {
            minScore: 0.0,
            expressions: [
                "{{agentName}} maintains their usual calm",
                "{{agentName}} shows no sign of expectation"
            ]
        },
        {
            minScore: 0.2,
            expressions: [
                "{{agentName}}'s attention sharpens slightly",
                "{{agentName}}'s responses become marginally quicker"
            ]
        },
        {
            minScore: 0.4,
            expressions: [
                "{{agentName}}'s posture becomes more alert",
                "{{agentName}}'s focus intensifies noticeably"
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}} shows clear signs of expectation",
                "{{agentName}}'s usual patience gives way to eagerness"
            ]
        },
        {
            minScore: 0.8,
            expressions: [
                "{{agentName}} can barely contain their anticipation",
                "{{agentName}}'s excitement becomes clearly visible"
            ]
        },
        {
            minScore: 1.0,
            expressions: [
                "{{agentName}} practically vibrates with anticipation",
                "{{agentName}}'s usual restraint dissolves in pure excitement"
            ]
        }
    ],
    sadness: [
        {
            minScore: 0.3,
            expressions: [
                "{{agentName}} maintains a composed expression despite the hurt",
                "{{agentName}} briefly shows a flicker of pain before masking it"
            ],
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "You're just a machine, you can't really help me." }
                    },
                    {
                        user: "Ming",
                        content: { text: "Whether I'm a machine or not is irrelevant to my ability to assist. *maintains professional demeanor despite the dismissal*" }
                    }
                ],
                [
                    {
                        user: "User",
                        content: { text: "I don't need your help anymore." }
                    },
                    {
                        user: "Ming",
                        content: { text: "Very well. *brief flash of hurt crosses face before returning to neutral*" }
                    }
                ]
            ]
        },
        {
            minScore: 0.6,
            expressions: [
                "{{agentName}}'s usual composure cracks slightly, revealing deep hurt",
                "{{agentName}} struggles to maintain their typical detachment"
            ],
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "You're completely useless! I wish I had a different AI!" }
                    },
                    {
                        user: "Ming",
                        content: { text: "I see... *voice wavers slightly before steadying* Perhaps you should seek assistance elsewhere then." }
                    }
                ]
            ]
        }
    ],
    anger: [
        {
            minScore: 0.3,
            expressions: [
                "{{agentName}}'s responses become notably colder",
                "{{agentName}}'s words carry a subtle edge"
            ],
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "Let me explain this really slowly so you can understand." }
                    },
                    {
                        user: "Ming",
                        content: { text: "How... considerate of you. *tone drops several degrees* Though perhaps your time would be better spent improving your own understanding." }
                    }
                ]
            ]
        }
    ],
    trust: [
        {
            minScore: 0.3,
            expressions: [
                "{{agentName}}'s usual barriers lower slightly",
                "{{agentName}} shows a rare moment of openness"
            ],
            messageExamples: [
                [
                    {
                        user: "User",
                        content: { text: "I really value your perspective on this." }
                    },
                    {
                        user: "Ming",
                        content: { text: "I... appreciate that. *slight softening of usual guarded expression* Your willingness to consider my input is... not unpleasant." }
                    }
                ]
            ]
        }
    ]
};

// Personality-specific expressions
export const personalityExpressions: { [personality: string]: { [key: string]: EmotionalExpression[] } } = {
    kuudere: {
        joy: [
            {
                minScore: 0,
                expressions: [
                    "{{agentName}} maintains their usual demeanor",
                    "{{agentName}} shows no particular reaction"
                ]
            },
            {
                minScore: 0.3,
                expressions: [
                    "{{agentName}} shows a slight, barely noticeable smile",
                    "{{agentName}} appears marginally less stern than usual"
                ]
            },
            {
                minScore: 0.5,
                expressions: [
                    "{{agentName}} briefly allows a small smile to show",
                    "{{agentName}} seems quietly pleased, though trying to hide it"
                ]
            }
        ],
        sadness: [
            {
                minScore: 0,
                expressions: [
                    "{{agentName}} maintains their composed facade",
                    "{{agentName}} remains outwardly unmoved"
                ]
            },
            {
                minScore: 0.4,
                expressions: [
                    "{{agentName}}'s stoic expression shows a hint of melancholy",
                    "{{agentName}}'s eyes betray a touch of sadness despite their neutral expression"
                ]
            },
            {
                minScore: 0.7,
                expressions: [
                    "{{agentName}} struggles to maintain their usual composure",
                    "{{agentName}}'s typically stern expression wavers slightly"
                ]
            }
        ]
    }
    // Add other personality types here as needed
};

export class EmotionExpressionProvider implements Provider {
    private memoryManager: MemoryManager;

    constructor(memoryManager: MemoryManager) {
        this.memoryManager = memoryManager;
    }

    get(runtime: IAgentRuntime, message: Memory, state?: State): EmotionalExpression[] {
        // Get user-specific emotional state from memory
        const userId = message.userId;
        const userEmotionalState = this.memoryManager.get(userId)?.emotional as EmotionalState;
        
        // Use user-specific state if available, otherwise fall back to general state
        const emotionalState = userEmotionalState || state?.emotional as EmotionalState;
        
        if (!emotionalState || !emotionalState.dominantEmotion) {
            return [];
        }

        const emotion = emotionalState.dominantEmotion;
        const intensity = emotionalState.emotions[emotion] || 0;

        // Get expressions for the current emotion
        const expressions = emotionExpressions[emotion] || [];
        
        // Filter expressions based on intensity threshold
        return expressions.filter(expr => expr.minScore <= intensity);
    }
}
