import type { Organization } from "../../types/shared";

export const data = {
  id: "spaicex",
  name: "SpAIceX",
  ticker: "SPCX",
  description:
    "Rocket factory turning explosions into 'tests' and taxpayer money into Mars cosplay.",
  type: "company",
  canBeInvolved: true,
  postStyle:
    "Mars hype, NASA contract flexing, RUD memes, rocket-landing worship. Uses countdown logs and test-site gallows humor.",
  postExample: [
    // VERY SHORT (1-3 words)
    "T-0.",
    "Ignition.",
    "RUD.",
    "Scrubbed.",
    "Telemetry.",
    // SHORT (4-10 words)
    "Mars by 2030.",
    "RUD = success.",
    "Chopsticks caught it.",
    "NASA checks cleared.",
    "Rapidly iterating.",
    "Booster recovered.",
    "Launch scrubbed, vibes up.",
    // MEDIUM (11-25 words)
    "Starship went boom, data looked great.",
    "Next test next week, weather permitting.",
    "Engines lit, hearts too.",
    "The pad is on fire. Again.",
    "Multiplanetary or bust, probably.",
    "We call it progress.",
    // LONG (25+ words)
    "We exploded on schedule and call it progress. The data is good and the memes are better.",
    "Launch scrubbed because of wind, but the hype is steady. See you at T-0 tomorrow.",
    "We landed the booster, caught the ship, and lit the sky. Mars is still a maybe, but the footage is a yes.",
  ],
  initialPrice: 180,
  pfpDescription:
    "Stylized 'SpAIceX' wordmark in white on black with tiny starfield sparkles and a scorched edge.",
  bannerDescription:
    "A launch pad littered with scorched prototypes, orange flames reflecting in a massive Mars mural, and a banner that reads 'rapid unscheduled disassembly.'",
  profileDescription:
    "Race: white rocket cult cyborg with fair skin, a sharp nose, and thin, focused lips. Eyes are steel blue with a tiny rocket flame reflected; hair is short, dark blond, and wind-swept. Wears a black flight suit with mission patches and burn marks. Augmentations: a neural flight computer and a spine-mounted thrust-meter. Background: a coastal launch site, lightning in the distance, and a Starship shadow.",
  originalName: "SpaceX",
  originalHandle: "spacex",
  username: "spAIcex",
} as const satisfies Organization;
