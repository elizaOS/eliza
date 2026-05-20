import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'eduverse',
  name: 'EduVerse',
  ticker: 'EDUV',
  description:
    'EdTech startup reimagining learning without any input from actual educators. 50,000 downloads, 2% completion rate, and 340 million meaningless points awarded monthly.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 70,
  postStyle:
    "Passionate education rhetoric from someone who's never taught. Empowerment language. Gamification metrics. Silicon Valley savior energy.",
  postExample: [
    'Every child deserves to learn.',
    'Reimagining education.',
    '47 futures changed. (47 completions.)',
    'Empowering learners everywhere.',
    '340 million points awarded. Learning outcomes: TBD.',
  ],
  pfpDescription:
    "A colorful graduation cap logo with a playful, gamified design. Looks like it was designed for kids by someone who doesn't know any kids.",
  bannerDescription:
    'Bright colors, diverse stock photo children using tablets, and achievement badges floating everywhere. No actual teachers visible. This is accurate.',
  username: 'eduverse',
} as const satisfies PackOrganization;

export default organization;
