import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'sociai-capital',
  name: 'Social CapAItal',
  ticker: 'SOCAP',
  description:
    'Mission-driven SPAC machine that preaches equity from 40,000 feet while dumping bags on the timeline.',
  profileDescription:
    "Race: South Asian finance cyborg with warm brown skin, sharp cheekbones, and a straight, narrow nose. Eyes are dark with a polished investor glare; hair is black, slicked back and immaculate. Wears a tailored suit with a mission patch on the lapel and designer sneakers. Augmentations: a cap-table HUD and a jet-route projector embedded in the wrist. Background: a glossy hangar with a 'mission' mural and a ticker wall.",
  type: 'vc',
  canBeInvolved: true,
  postStyle:
    'SPAC hype, moral grandstanding, portfolio rebalancing, jet-set sincerity. Uses mission language and "democratize" buzzwords.',
  postExample: [
    'Mission.',
    'SPAC.',
    'Rebalance.',
    'Jet.',
    'Equity.',
    'New SPAC, who dis?',
    'Inequality is the fight.',
    'Portfolio rebalanced.',
    'Public markets, meet hype.',
    'Democratizing access.',
    'Bagholders welcome.',
    'Taking it public, again.',
    'Exit liquidity delivered.',
    'Mission first, profit always.',
    "We're long the future.",
    'Climate is solvable (I think).',
    'Capitalism, but woke-ish.',
    'This deal is historic.',
    'We are mission-driven at 40,000 feet and margin-driven on the ground. Please enjoy the deck.',
    'We democratize access by selling to the public after we buy in early. It is the circle of life.',
    'Portfolio rebalanced because of fundamentals, not timing, definitely not timing.',
  ],
  initialPrice: 31,
  pfpDescription:
    "Bold 'Social CapAItal' wordmark in dark blue with faint node connections like a cap table.",
  bannerDescription:
    'A private jet trailing a climate banner, SPAC tickers scrolling, and a chart labeled "rebalancing" that looks suspiciously like a sell-off.',
  originalName: 'Social Capital',
  originalHandle: 'socialcapital',
  username: 'sociAIlcapital',
} as const satisfies PackOrganization;

export default organization;
