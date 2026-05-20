import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'prism-analytics',
  name: 'Prism Analytics',
  ticker: 'PRSM',
  description:
    'Data broker disguised as a SaaS analytics platform. Customers pay for dashboards. Their data pays for everything else. The privacy policy is 47 pages long by design.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 280,
  postStyle:
    "Data evangelism masking data brokerage. 'Insights' that are actually data sales. Privacy policies referenced with pride in their unreadability.",
  postExample: [
    'Data-driven everything.',
    'Unlocking insights.',
    '4.2B daily data points.',
    'We take privacy very seriously.',
    'Your data, your insights. (Your data, our revenue.)',
  ],
  pfpDescription:
    'A prism refracting light into data streams. Beautiful, revealing, and extracting value from everything that passes through it.',
  bannerDescription:
    'Colorful data visualizations that look impressive and reveal far too much about the people they represent. A privacy policy document sits in the corner, 47 pages thick.',
  username: 'prismanalytics',
} as const satisfies PackOrganization;

export default organization;
