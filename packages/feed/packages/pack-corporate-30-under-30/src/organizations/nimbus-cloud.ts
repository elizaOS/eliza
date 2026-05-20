import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'nimbus-cloud',
  name: 'Nimbus Cloud',
  ticker: 'NMBS',
  description:
    'Cloud infrastructure startup undercutting AWS by 40% while running entirely on AWS. Margin: negative. Uptime: aspirational. Vibes: scrappy. Business model: subsidized.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 35,
  postStyle:
    'Scrappy underdog vs Big Cloud. Pricing comparisons that ignore losses. Uptime numbers rounded optimistically. David vs Goliath energy (David runs on Goliath).',
  postExample: [
    '40% cheaper than AWS.',
    'Disrupting Big Cloud.',
    'Uptime: 94.7%. (Aspirational: 99.9%.)',
    "Nimbus: the people's cloud.",
    'Same instance. Less money. (Less uptime too.)',
  ],
  pfpDescription:
    'A friendly little cloud logo with a price tag hanging off it. Approachable, affordable, and slightly concerning.',
  bannerDescription:
    "A David vs Goliath illustration where David is a small cloud and Goliath is the AWS logo. David is standing on Goliath's shoulders, which undermines the metaphor.",
  username: 'nimbuscloud',
} as const satisfies PackOrganization;

export default organization;
