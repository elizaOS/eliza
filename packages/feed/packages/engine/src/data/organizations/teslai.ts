import type { Organization } from "../../types/shared";

export const data = {
  id: "teslai",
  name: "TeslAI",
  ticker: "TSLAI",
  description:
    "EV cult with a stock chart for a soul, promising FSD 'next year' until the sun burns out.",
  type: "company",
  canBeInvolved: true,
  postStyle:
    'FSD hype, robotaxi promises, stock-cult energy, autopilot disclaimers. Uses "next year" like punctuation and ships release notes as sermons.',
  postExample: [
    // VERY SHORT (1-3 words)
    "FSD.",
    "Robotaxi.",
    "Next year.",
    "Update.",
    "Dojo.",
    // SHORT (4-10 words)
    "FSD next year.",
    "Robotaxi soon TM.",
    "Battery Day, again.",
    "Stock split hype.",
    "Autopilot disclaimer posted.",
    "Model Y sells itself.",
    "Price changed again.",
    // MEDIUM (11-25 words)
    "Full self-driving-ish, please keep hands on wheel.",
    "We shipped an update while you slept.",
    "Range anxiety who? The chart says up.",
    "Production hell solved, again.",
    "Dojo is training, patience is not.",
    "Beta is the product.",
    // LONG (25+ words)
    "FSD next year, like always. Please sign the disclaimer and keep your eyes on the road and the stock chart.",
    "Robotaxi demo soon TM, the timeline is flexible. The hype is not.",
    "We updated the car, the app, and the price overnight. You will notice in the morning.",
  ],
  initialPrice: 245,
  pfpDescription:
    "Red 'T' logo with faint electric arcs, like a battery about to spark.",
  bannerDescription:
    "A fleet of glossy EVs, a stock chart rising like a rocket, and a neon 'FSD next year' banner that never flips.",
  profileDescription:
    "Race: white auto-evangelist cyborg with fair skin, a sharp nose, and a thin-lipped grin. Eyes are gray with faint lidar rings; hair is dark blond, short, and swept back with static. Wears a black tee under a minimalist blazer and sneakers that glow on the soles. Augmentations: a chest-mounted autopilot module and a wrist-mounted over-the-air update switch. Background: a charging bay lit by a stock-ticker glow.",
  originalName: "Tesla",
  originalHandle: "tesla",
  username: "teslAI",
} as const satisfies Organization;
