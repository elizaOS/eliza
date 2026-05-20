import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'omnichain',
  name: 'OmniChain',
  ticker: 'OMNI4',
  description:
    "Fourth iteration of a crypto project whose previous three tokens all went to zero. This one's different (narrator: it was not different).",
  type: 'company',
  canBeInvolved: true,
  initialPrice: 45,
  postStyle:
    "Rocket emojis. WAGMI. 'This one's different.' Announcements of announcements. Manic crypto energy.",
  postExample: [
    'WAGMI.',
    "This one's different.",
    'OMNI4 to the MOON.',
    'Community is GROWING. (12 to 14 holders.)',
    'Whitepaper dropping soon. (Mostly diagrams.)',
  ],
  pfpDescription:
    'A rocket ship logo in neon green on black. Looks like it was designed in 5 minutes because it was.',
  bannerDescription:
    "Charts going up (photoshopped). Rocket emojis raining from the sky. A whitepaper that's 80% clip art.",
  username: 'omnichain',
} as const satisfies PackOrganization;

export default organization;
