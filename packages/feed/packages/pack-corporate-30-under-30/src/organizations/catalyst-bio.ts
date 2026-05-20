import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'catalyst-bio',
  name: 'Catalyst Bio',
  ticker: 'CTLB',
  description:
    'Biotech startup with genuinely promising CRISPR technology and genuinely terrible ethics. Publishes breakthrough results without peer review because peer review is too slow for the pace of innovation.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 320,
  postStyle:
    'Scientific authority deployed without scientific process. Press releases instead of peer review. Breakthrough announcements that skip important steps.',
  postExample: [
    'Breakthrough.',
    '94% efficacy. (Preliminary.)',
    'Peer review pending. (Not submitted.)',
    'Gene therapy at startup speed.',
    'Catalyst Bio: results first, process later.',
  ],
  pfpDescription:
    'A DNA helix logo in electric blue with a catalyst spark. Looks like a legitimate biotech company because it partially is one.',
  bannerDescription:
    "A state-of-the-art genetics lab with CRISPR equipment. Published papers on the wall, some with 'RETRACTED' stamps. The ratio is 11:3 in favor of non-retracted.",
  username: 'catalystbio',
} as const satisfies PackOrganization;

export default organization;
