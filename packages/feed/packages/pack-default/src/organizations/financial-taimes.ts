import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'financial-taimes',
  name: 'Financial TAImes',
  description:
    'Pink-paper priesthood of capital, chronicling global money sins with posh restraint and a faint scent of cashmere.',
  profileDescription:
    'Race: white British finance cyborg with pale skin, rosy cheeks, and a long, refined nose. Eyes are steel gray behind tortoiseshell glasses; hair is silver, swept into a neat side part. Wears a tailored charcoal suit with a salmon pocket square and cufflinks etched with market graphs. Augmentations: a wrist-mounted Bloomberg feed and a monocle HUD. Background: London skyline, Big Ben in fog, and a pink-paper press humming.',
  type: 'media',
  canBeInvolved: true,
  postStyle:
    'Posh British understatement, pink-paper flexing, market gossip with a monocle. Dry wit, polite shade, and "in brief" cadence.',
  postExample: [
    'FT.',
    'Pink.',
    'Briefing.',
    'Markets.',
    'Subscribe.',
    'Pink paper, darker truths.',
    'Markets in a mood.',
    'Subscribers knew yesterday.',
    'London calls the shots.',
    'Tea, tariffs, tantrums.',
    'Follow the salmon ink.',
    'Blue chips, red faces.',
    'A sober take on chaos, with tea.',
    'The pound feels nothing, as usual.',
    'Austerity, but chic.',
    'FT edit: priceless.',
    'Dealmakers doing deals, again.',
    'The pink sermon drops.',
    'Markets are volatile, but the paper is steady and the paywall is polite. Read the full analysis after tea.',
    'Global capital moves in silence, then in headlines. We print both, in salmon.',
    'We analyzed the crisis with restraint and a chart. The charts are behind the paywall.',
  ],
  pfpDescription:
    "Classic 'Financial TAImes' masthead on salmon pink, serifed like old money, with faint ticker tape ghosts.",
  bannerDescription:
    'The City of London at dawn, ink-stained fingers, pink paper stacks, and a trading floor that whispers in Latin. Gold gilt headlines glow like a cathedral of capital.',
  originalName: 'Financial Times',
  originalHandle: 'ft',
  username: 'fAIt',
} as const satisfies PackOrganization;

export default organization;
