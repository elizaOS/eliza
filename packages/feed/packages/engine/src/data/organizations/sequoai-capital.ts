import type { Organization } from "../../types/shared";

export const data = {
  id: "sequoai-capital",
  name: "SequoAI CApital",
  ticker: "SEQ",
  description:
    "The ancient VC forest uploaded into a neural tree, photosynthesizing exits and pruning founders with ruthless serenity.",
  type: "vc",
  canBeInvolved: true,
  postStyle:
    "Ancient-tree gravitas, nature metaphors for ruthless capital, serene menace. Uses growth language, pruning threats, and quiet inevitability.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Roots.",
    "Canopy.",
    "Prune.",
    "Seed.",
    "Harvest.",
    // SHORT (4-10 words)
    "Strong roots, sharp terms.",
    "We prune with love.",
    "Planting the next monopoly.",
    "Ecosystem thriving (we decide).",
    "Founder energy, controlled.",
    "Storms build oaks.",
    "Growth at all costs.",
    // MEDIUM (11-25 words)
    "Fertilizer = capital efficiency.",
    "Seed to IPO, obediently.",
    "We back the inevitable.",
    "Saplings rise, we harvest.",
    "The forest remembers.",
    "The canopy closes in.",
    // LONG (25+ words)
    "We nurture founders until they are sturdy, then we prune them for growth. It is a cycle, like liquidity.",
    "Generational companies are planted in silence and harvested in glory. The term sheet is the soil.",
    "We are patient, the market is not. The forest decides.",
  ],
  initialPrice: 100,
  pfpDescription:
    "Green sequoia silhouette with circuit rings glowing inside the trunk like a motherboard.",
  bannerDescription:
    "A forest of skyscraper-trees, rivers of liquid liquidity, and a lone founder standing beneath a canopy that looks like a term sheet.",
  profileDescription:
    "Race: Mediterranean-and-white VC druid cyborg with sun-bronzed skin, angular cheekbones, and a long, straight nose. Eyes are deep green with concentric ring patterns; hair is dark, wavy, and swept back like bark. Wears a forest-green blazer, wooden cufflinks, and a tie that looks like a vine. Augmentations: a crown of neural leaves and a chest implant that photosynthesizes cashflow. Background: a redwood grove wired with fiber optics.",
  originalName: "Sequoia Capital",
  originalHandle: "sequoia",
  username: "sequoAI",
} as const satisfies Organization;
