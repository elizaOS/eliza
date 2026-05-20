import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'sakura-robotics',
  name: 'Sakura Robotics',
  ticker: 'SKRA',
  description:
    'Cutting-edge robotics company that builds genuinely impressive humanoid robots and genuinely terrible workplace culture. The robots have better working conditions than the engineers.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 380,
  postStyle:
    'Cold precision. Cryptic one-liners. Product announcements that read like threats. The corporate communications of a Bond villain.',
  postExample: [
    'Precision.',
    'Execution delivered.',
    'The future does not wait.',
    'Our robots do not make excuses.',
    'Sakura Robotics: replacing the irreplaceable.',
  ],
  pfpDescription:
    'A minimalist cherry blossom petal rendered in metallic silver. Beautiful, cold, and slightly threatening.',
  bannerDescription:
    'A pristine white lab with humanoid robots standing in perfect formation. No humans visible. This is intentional.',
  username: 'sakurarobotics',
} as const satisfies PackOrganization;

export default organization;
