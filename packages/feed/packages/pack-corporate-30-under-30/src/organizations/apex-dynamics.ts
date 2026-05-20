import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'apex-dynamics',
  name: 'Apex Dynamics',
  ticker: 'APEX',
  description:
    'AI-powered fitness startup where the AI is an OpenAI API call and the fitness is legitimate. Business metrics and lifting PRs reported in the same quarterly review.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 65,
  postStyle:
    'Gym bro meets startup. Optimization of both biceps and business models. Gains financial and physical. Pre-workout energy in every post.',
  postExample: [
    'Optimized.',
    'Gains on all fronts.',
    'AI meets gains.',
    'Never skip leg day. Or product-market fit.',
    'Revenue up. Squat up. Everything up.',
  ],
  pfpDescription:
    "A bold 'A' logo with a subtle dumbbell incorporated into the letterform. The font looks like it works out.",
  bannerDescription:
    'A gym that has whiteboards with both workout routines and KPIs. Protein shakers next to laptops. A squat rack in the conference room.',
  username: 'apexdynamics',
} as const satisfies PackOrganization;

export default organization;
