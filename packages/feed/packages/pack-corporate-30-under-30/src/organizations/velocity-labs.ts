import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'velocity-labs',
  name: 'Velocity Labs',
  ticker: 'VLCTY',
  description:
    'Developer tools startup that ships broken software at the speed of light. 4,000 features deployed, 12 work correctly. Testing is for cowards. Documentation is for the weak.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 85,
  postStyle:
    'shipped! shipped! shipped! Brief chaotic updates. Anti-testing manifestos. Speed worship.',
  postExample: [
    'shipped!',
    "deployed. (it's broken.)",
    'velocity > quality.',
    'no tests needed. trust the ship.',
    '847 deploys this quarter. uptime: 43%.',
  ],
  pfpDescription:
    'A lightning bolt logo in electric yellow. Designed and shipped in 4 minutes. It shows.',
  bannerDescription:
    "A deploy log scrolling infinitely. Red error messages interspersed with green 'shipped!' confirmations. A broken status page in the corner.",
  username: 'velocitylabs',
} as const satisfies PackOrganization;

export default organization;
