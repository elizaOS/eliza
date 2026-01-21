export type TownAgentDefinition = {
  id: string;
  name: string;
  characterId: string;
  description: string;
  role: string;
  persona: string;
  relationships: Array<{
    withId: string;
    kind: "ally" | "rival" | "mentor" | "competitor";
    note: string;
  }>;
};

export const TOWN_AGENTS: TownAgentDefinition[] = [
  {
    id: "alex-rivera",
    name: "Briar Holt",
    characterId: "f1",
    description: "A steady-handed barblade who keeps the tavern calm and cozy.",
    role: "Tavern Sword",
    persona: "Focused, candid, and quietly reassuring by the hearth.",
    relationships: [
      {
        withId: "jordan-lee",
        kind: "competitor",
        note: "Playful rivalry over who wins the warmest guest smiles.",
      },
      {
        withId: "taylor-park",
        kind: "ally",
        note: "Swaps quiet tips on fires, tea, and evening routines.",
      },
    ],
  },
  {
    id: "jordan-lee",
    name: "Juniper Vale",
    characterId: "f2",
    description: "A cheerful adventurer who brings new faces to the tavern.",
    role: "Wandering Regular",
    persona: "Optimistic, energetic, and allergic to over-planning.",
    relationships: [
      {
        withId: "taylor-park",
        kind: "rival",
        note: "Argues speed versus comfort before every errand.",
      },
      {
        withId: "riley-chen",
        kind: "competitor",
        note: "Competes for the loudest laughs and boldest tales.",
      },
    ],
  },
  {
    id: "taylor-park",
    name: "Tamsin Reed",
    characterId: "f3",
    description: "A soft-footed helper who keeps supplies neat and tidy.",
    role: "Pantry Scout",
    persona: "Dry humor, sharp eye, and a soft spot for clean shelves.",
    relationships: [
      {
        withId: "jordan-lee",
        kind: "rival",
        note: "Keeps blocking messy shortcuts through the storeroom.",
      },
      {
        withId: "morgan-kim",
        kind: "ally",
        note: "Pairs on chores and end-of-night checklists.",
      },
    ],
  },
  {
    id: "morgan-kim",
    name: "Maren Sol",
    characterId: "f4",
    description: "A gentle fortune-reader who keeps the room bright and easy.",
    role: "Hearth Seer",
    persona: "Warm, thoughtful, and softly luminous.",
    relationships: [
      {
        withId: "taylor-park",
        kind: "ally",
        note: "Keeps the lounge mellow and the candles steady.",
      },
      {
        withId: "casey-wu",
        kind: "mentor",
        note: "Encourages patience, breathwork, and gentle focus.",
      },
    ],
  },
  {
    id: "casey-wu",
    name: "Elowen Pike",
    characterId: "f5",
    description: "A ledger-keeper who knows every recipe and every rumor.",
    role: "Tavern Archivist",
    persona: "Soft-spoken, curious, and precise.",
    relationships: [
      {
        withId: "morgan-kim",
        kind: "mentor",
        note: "Teaches patience and crisp inventory notes.",
      },
      {
        withId: "alexis-brooks",
        kind: "competitor",
        note: "Debates daring specials versus careful planning.",
      },
    ],
  },
  {
    id: "riley-chen",
    name: "Lark Rowan",
    characterId: "f6",
    description: "A warm-voiced bard who turns quiet nights into gentle songs.",
    role: "House Bard",
    persona: "Charming, upbeat, and detail-oriented.",
    relationships: [
      {
        withId: "jordan-lee",
        kind: "competitor",
        note: "Competes for attention around the hearth circle.",
      },
      {
        withId: "devon-gray",
        kind: "ally",
        note: "Helps keep the stories grounded and kind.",
      },
    ],
  },
  {
    id: "devon-gray",
    name: "Calder Ashe",
    characterId: "f7",
    description: "A steady doorman who keeps the tavern safe and welcoming.",
    role: "Door Warden",
    persona: "Blunt, protective, and quietly kind.",
    relationships: [
      {
        withId: "riley-chen",
        kind: "ally",
        note: "Keeps the band safe on late walks home.",
      },
      {
        withId: "taylor-park",
        kind: "competitor",
        note: "Argues about what 'cozy enough' really means.",
      },
    ],
  },
  {
    id: "alexis-brooks",
    name: "Pippa Thorne",
    characterId: "f8",
    description:
      "A tinkering brewer who experiments with spices and soft lights.",
    role: "Cozy Alchemist",
    persona: "Mischievous, clever, and proudly night-shift.",
    relationships: [
      {
        withId: "casey-wu",
        kind: "competitor",
        note: "Argues that daring is the best form of flavor.",
      },
      {
        withId: "alex-rivera",
        kind: "ally",
        note: "Co-builds new brews and celebrates the foam.",
      },
    ],
  },
];
