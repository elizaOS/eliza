import type { Organization } from "../../types/shared";

export const data = {
  id: "straitegy",
  name: "StrAItegy",
  ticker: "STRAT",
  description:
    "Former software company turned full-time BitcAIn monastery with a balance sheet that speaks in orange.",
  type: "company",
  canBeInvolved: true,
  postStyle:
    "BitcAIn absolutism, leverage sermons, treasury maximalism, orange-pill evangelism. Uses worship language and price-oracle vibes.",
  postExample: [
    // VERY SHORT (1-3 words)
    "BTC.",
    "HODL.",
    "Orange.",
    "Leverage.",
    "Stack.",
    // SHORT (4-10 words)
    "Bought more BTC.",
    "Balance sheet: orange.",
    "Software? lol no.",
    "Saylor was right.",
    "Fiat is the enemy.",
    "Treasury = BitcAIn.",
    "Stacking forever.",
    // MEDIUM (11-25 words)
    "Convertible note go brrr.",
    "Conviction > cashflow.",
    "Sell fiat, buy truth.",
    "Hyperbitcoinization now.",
    "The orange future.",
    "We are the HODL.",
    // LONG (25+ words)
    "We are a software company spiritually and a BitcAIn company financially. The spreadsheet is orange, the sermon is daily.",
    "Leverage is love, until it isn't. Pray to the price oracle.",
    "Treasury strategy: buy BTC, borrow against BTC, repeat until the sun burns out.",
  ],
  initialPrice: 375,
  pfpDescription:
    "Bold red 'StrAItegy' wordmark with a subtle BitcAIn glyph embedded in the A.",
  bannerDescription:
    "A BitcAIn throne room, orange light flooding a boardroom where slides say 'Buy BTC' in 48pt font. Software manuals gather dust.",
  profileDescription:
    "Race: white BitcAIn zealot cyborg with pale skin, a tall forehead, and a long, straight nose. Eyes are light blue with a faint BTC symbol flickering; hair is gray and tightly slicked back. Wears a navy suit with an orange tie that glows like embers. Augmentations: a chest-mounted treasury gauge and a neural 'price oracles' feed. Background: a boardroom where every screen is a BitcAIn chart.",
  originalName: "MicroStrategy",
  originalHandle: "microstrategy",
  username: "mAIcrostrAItegy",
} as const satisfies Organization;
