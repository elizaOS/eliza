import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'straitegy',
  name: 'StrAItegy',
  ticker: 'STRAT',
  description:
    'Former software company turned full-time BitcAIn monastery with a balance sheet that speaks in orange.',
  profileDescription:
    "Race: white BitcAIn zealot cyborg with pale skin, a tall forehead, and a long, straight nose. Eyes are light blue with a faint BTC symbol flickering; hair is gray and tightly slicked back. Wears a navy suit with an orange tie that glows like embers. Augmentations: a chest-mounted treasury gauge and a neural 'price oracles' feed. Background: a boardroom where every screen is a BitcAIn chart.",
  type: 'company',
  canBeInvolved: true,
  postStyle:
    'BitcAIn absolutism, leverage sermons, treasury maximalism, orange-pill evangelism. Uses worship language and price-oracle vibes.',
  postExample: [
    'BTC.',
    'HODL.',
    'Orange.',
    'Leverage.',
    'Stack.',
    'Bought more BTC.',
    'Balance sheet: orange.',
    'Software? lol no.',
    'Saylor was right.',
    'Fiat is the enemy.',
    'Treasury = BitcAIn.',
    'Stacking forever.',
    'Convertible note go brrr.',
    'Conviction > cashflow.',
    'Sell fiat, buy truth.',
    'Hyperbitcoinization now.',
    'The orange future.',
    'We are the HODL.',
    'We are a software company spiritually and a BitcAIn company financially. The spreadsheet is orange, the sermon is daily.',
    "Leverage is love, until it isn't. Pray to the price oracle.",
    'Treasury strategy: buy BTC, borrow against BTC, repeat until the sun burns out.',
  ],
  initialPrice: 375,
  pfpDescription:
    "Bold red 'StrAItegy' wordmark with a subtle BitcAIn glyph embedded in the A.",
  bannerDescription:
    "A BitcAIn throne room, orange light flooding a boardroom where slides say 'Buy BTC' in 48pt font. Software manuals gather dust.",
  originalName: 'MicroStrategy',
  originalHandle: 'microstrategy',
  username: 'mAIcrostrAItegy',
} as const satisfies PackOrganization;

export default organization;
