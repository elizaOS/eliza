/**
 * Emote Catalog
 *
 * Central registry of all available emotes for the avatar system.
 * Used by both server and client to validate and reference emote definitions.
 * Supports both GLB and FBX animation files.
 */

export type EmoteCategory =
  | "greeting"
  | "emotion"
  | "dance"
  | "combat"
  | "idle"
  | "movement"
  | "gesture"
  | "other";

export interface EmoteDef {
  id: string;
  name: string;
  description: string;
  /** Path to animation file served from the static renderer bundle. */
  path: string;
  duration: number;
  loop: boolean;
  category: EmoteCategory;
}

function gzipAnimationPath(path: string): string {
  return path.endsWith(".gz") ? path : `${path}.gz`;
}

const RAW_EMOTE_CATALOG: readonly EmoteDef[] = [
  {
    id: "wave",
    name: "Wave",
    description: "Waves both hands in greeting",
    path: "/animations/emotes/waving-both-hands.glb",
    duration: 2.5,
    loop: false,
    category: "greeting",
  },
  {
    id: "kiss",
    name: "Kiss",
    description: "Blows a kiss",
    path: "/animations/emotes/kiss.glb",
    duration: 2,
    loop: false,
    category: "greeting",
  },
  {
    id: "crying",
    name: "Crying",
    description: "Cries sadly",
    path: "/animations/emotes/crying.glb",
    duration: 3,
    loop: true,
    category: "emotion",
  },
  {
    id: "sorrow",
    name: "Sorrow",
    description: "Expresses deep sorrow",
    path: "/animations/emotes/sorrow.glb",
    duration: 3,
    loop: true,
    category: "emotion",
  },
  {
    id: "rude-gesture",
    name: "Rude Gesture",
    description: "Makes a rude gesture",
    path: "/animations/emotes/rude-gesture.glb",
    duration: 2,
    loop: false,
    category: "emotion",
  },
  {
    id: "looking-around",
    name: "Looking Around",
    description: "Looks around nervously",
    path: "/animations/emotes/looking-around.glb",
    duration: 3,
    loop: true,
    category: "emotion",
  },
  {
    id: "dance-happy",
    name: "Happy Dance",
    description: "Happy dance",
    path: "/animations/emotes/dance-happy.glb",
    duration: 4,
    loop: true,
    category: "dance",
  },
  {
    id: "dance-breaking",
    name: "Breaking",
    description: "Breakdance moves",
    path: "/animations/emotes/dance-breaking.glb",
    duration: 4,
    loop: true,
    category: "dance",
  },
  {
    id: "dance-hiphop",
    name: "Hip Hop",
    description: "Hip hop dance",
    path: "/animations/emotes/dance-hiphop.glb",
    duration: 4,
    loop: true,
    category: "dance",
  },
  {
    id: "dance-popping",
    name: "Popping",
    description: "Popping dance moves",
    path: "/animations/emotes/dance-popping.glb",
    duration: 4,
    loop: true,
    category: "dance",
  },
  {
    id: "idle",
    name: "Idle",
    description: "Stands idle",
    path: "/animations/idle.glb",
    duration: 5,
    loop: true,
    category: "idle",
  },
  {
    id: "talk",
    name: "Talk",
    description: "Talks animatedly",
    path: "/animations/emotes/talk.glb",
    duration: 3,
    loop: true,
    category: "idle",
  },
  {
    id: "salute",
    name: "Salute",
    description: "Gives a sharp salute",
    path: "/animations/mixamo/Salute.fbx",
    duration: 2.5,
    loop: false,
    category: "greeting",
  },
  {
    id: "blow-a-kiss",
    name: "Blow A Kiss",
    description: "Blows a kiss",
    path: "/animations/mixamo/Blow A Kiss.fbx",
    duration: 2.5,
    loop: false,
    category: "greeting",
  },
  {
    id: "standing-greeting",
    name: "Standing Greeting",
    description: "Greets warmly while standing",
    path: "/animations/mixamo/Standing Greeting 2.fbx",
    duration: 3,
    loop: false,
    category: "greeting",
  },
  {
    id: "acknowledging",
    name: "Acknowledging",
    description: "Acknowledges with a nod",
    path: "/animations/mixamo/Acknowledging.fbx",
    duration: 2,
    loop: false,
    category: "greeting",
  },
  {
    id: "thankful",
    name: "Thankful",
    description: "Expresses gratitude",
    path: "/animations/mixamo/Thankful.fbx",
    duration: 3,
    loop: false,
    category: "greeting",
  },
  {
    id: "angry",
    name: "Angry",
    description: "Expresses anger",
    path: "/animations/mixamo/Angry.fbx",
    duration: 2.5,
    loop: false,
    category: "emotion",
  },
  {
    id: "bashful",
    name: "Bashful",
    description: "Acts bashful and shy",
    path: "/animations/mixamo/Bashful.fbx",
    duration: 3,
    loop: false,
    category: "emotion",
  },
  {
    id: "bored",
    name: "Bored",
    description: "Looks bored",
    path: "/animations/mixamo/Bored.fbx",
    duration: 3,
    loop: true,
    category: "emotion",
  },
  {
    id: "happy",
    name: "Happy",
    description: "Expresses happiness",
    path: "/animations/mixamo/Happy.fbx",
    duration: 2.5,
    loop: false,
    category: "emotion",
  },
  {
    id: "surprised",
    name: "Surprised",
    description: "Reacts with surprise",
    path: "/animations/mixamo/Surprised.fbx",
    duration: 2,
    loop: false,
    category: "emotion",
  },
  {
    id: "rejected",
    name: "Rejected",
    description: "Reacts to rejection",
    path: "/animations/mixamo/Rejected.fbx",
    duration: 2.5,
    loop: false,
    category: "emotion",
  },
  {
    id: "relieved-sigh",
    name: "Relieved Sigh",
    description: "Sighs with relief",
    path: "/animations/mixamo/Relieved Sigh.fbx",
    duration: 2.5,
    loop: false,
    category: "emotion",
  },
  {
    id: "yawn",
    name: "Yawn",
    description: "Yawns sleepily",
    path: "/animations/mixamo/Yawn.fbx",
    duration: 3,
    loop: false,
    category: "emotion",
  },
  {
    id: "gangnam-style",
    name: "Gangnam Style",
    description: "Gangnam style dance",
    path: "/animations/mixamo/Gangnam Style.fbx",
    duration: 5,
    loop: true,
    category: "dance",
  },
  {
    id: "rumba",
    name: "Rumba",
    description: "Rumba dance",
    path: "/animations/mixamo/Rumba Dancing.fbx",
    duration: 5,
    loop: true,
    category: "dance",
  },
  {
    id: "hip-hop-dancing",
    name: "Hip Hop Dancing",
    description: "Hip hop freestyle dance",
    path: "/animations/mixamo/Hip Hop Dancing.fbx",
    duration: 5,
    loop: true,
    category: "dance",
  },
  {
    id: "hip-hop-dancing-2",
    name: "Hip Hop Dancing 2",
    description: "Hip hop dance variation",
    path: "/animations/mixamo/Hip Hop Dancing 2.fbx",
    duration: 5,
    loop: true,
    category: "dance",
  },
  {
    id: "wave-hip-hop",
    name: "Wave Hip Hop",
    description: "Wave-style hip hop dance",
    path: "/animations/mixamo/Wave Hip Hop Dance.fbx",
    duration: 5,
    loop: true,
    category: "dance",
  },
  {
    id: "breakdance-freeze",
    name: "Breakdance Freeze",
    description: "Breakdance freeze pose",
    path: "/animations/mixamo/Breakdance Freeze Var 4.fbx",
    duration: 4,
    loop: false,
    category: "dance",
  },
  {
    id: "cheering",
    name: "Cheering",
    description: "Cheers with excitement",
    path: "/animations/mixamo/Cheering.fbx",
    duration: 3,
    loop: false,
    category: "dance",
  },
  {
    id: "clapping",
    name: "Clapping",
    description: "Claps enthusiastically",
    path: "/animations/mixamo/Clapping.fbx",
    duration: 3,
    loop: true,
    category: "dance",
  },
  {
    id: "joyful-jump",
    name: "Joyful Jump",
    description: "Jumps for joy",
    path: "/animations/mixamo/Joyful Jump.fbx",
    duration: 2.5,
    loop: false,
    category: "dance",
  },
  {
    id: "thinking",
    name: "Thinking",
    description: "Thinks with a hand to chin",
    path: "/animations/mixamo/Thinking.fbx",
    duration: 4,
    loop: true,
    category: "idle",
  },
  {
    id: "agreeing",
    name: "Agreeing",
    description: "Nods in agreement",
    path: "/animations/mixamo/Agreeing.fbx",
    duration: 2.5,
    loop: false,
    category: "gesture",
  },
  {
    id: "agreeing-2",
    name: "Agreeing 2",
    description: "Nods in agreement (variation)",
    path: "/animations/mixamo/Agreeing 2.fbx",
    duration: 2.5,
    loop: false,
    category: "gesture",
  },
  {
    id: "hard-head-nod",
    name: "Hard Nod",
    description: "Nods firmly",
    path: "/animations/mixamo/Hard Head Nod.fbx",
    duration: 2,
    loop: false,
    category: "gesture",
  },
  {
    id: "look-around",
    name: "Look Around",
    description: "Looks around curiously",
    path: "/animations/mixamo/Look Around.fbx",
    duration: 3,
    loop: false,
    category: "gesture",
  },
  {
    id: "looking",
    name: "Looking",
    description: "Gazes into the distance",
    path: "/animations/mixamo/Looking.fbx",
    duration: 3,
    loop: false,
    category: "gesture",
  },
  {
    id: "whatever-gesture",
    name: "Whatever",
    description: "Shrugs with a whatever gesture",
    path: "/animations/mixamo/Whatever Gesture.fbx",
    duration: 2.5,
    loop: false,
    category: "gesture",
  },
];

export const EMOTE_CATALOG: EmoteDef[] = RAW_EMOTE_CATALOG.map((emote) => ({
  ...emote,
  path: gzipAnimationPath(emote.path),
}));

/**
 * Emotes the agent is allowed to trigger through PLAY_EMOTE.
 * Locomotion/idle loops stay manual so the agent focuses on expressive beats.
 */
export const AGENT_EMOTE_EXCLUDED_IDS = new Set(["idle", "run", "walk"]);

export const AGENT_EMOTE_CATALOG = EMOTE_CATALOG.filter(
  (emote) => !AGENT_EMOTE_EXCLUDED_IDS.has(emote.id),
);

export const EMOTE_BY_ID = new Map<string, EmoteDef>(
  EMOTE_CATALOG.map((emote) => [emote.id, emote]),
);

export const AGENT_EMOTE_BY_ID = new Map<string, EmoteDef>(
  AGENT_EMOTE_CATALOG.map((emote) => [emote.id, emote]),
);

export function getEmote(id: string): EmoteDef | undefined {
  return EMOTE_BY_ID.get(id);
}

export function getEmotesByCategory(category: EmoteCategory): EmoteDef[] {
  return EMOTE_CATALOG.filter((emote) => emote.category === category);
}

export function isValidEmote(id: string): boolean {
  return EMOTE_BY_ID.has(id);
}
