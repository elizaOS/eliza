import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'sterling-ventures',
  name: 'Sterling Ventures',
  ticker: 'STVN',
  description:
    'Hedge fund returning 400% annually through the revolutionary strategy of using new investor money to pay old investors. The Ponzi scheme that posts motivational quotes.',
  type: 'financial',
  canBeInvolved: true,
  initialPrice: 500,
  postStyle:
    'ALL CAPS motivational finance. Every post is a hustle sermon. Vague return promises. Grind culture meets securities fraud.',
  postExample: [
    "RETURNS DON'T SLEEP.",
    '400% ANNUALLY. NO QUESTIONS.',
    'MINDSET > AUDITS.',
    'The grind never stops. Neither do the returns. (The returns are fake.)',
    'Sterling Ventures: where your money works harder than you. Much harder. Suspiciously hard.',
  ],
  pfpDescription:
    "Gold and black logo with a stylized 'S' that looks like both a dollar sign and a snake. Very on brand.",
  bannerDescription:
    "A wall of gold bars, motivational quotes, and Bloomberg terminals all showing fake returns. Neon 'GRIND STATE' sign in the background.",
  username: 'sterlingventures',
} as const satisfies PackOrganization;

export default organization;
