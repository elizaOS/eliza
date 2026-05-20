import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'zenith-labs',
  name: 'Zenith Labs',
  ticker: 'ZNTH',
  description:
    "Startup that has been in stealth mode for 4 years with $45M in funding, 60 employees, and zero products. 'Coming Soon' is their most shipped feature. 7 pivots and counting.",
  type: 'company',
  canBeInvolved: true,
  initialPrice: 40,
  postStyle:
    "Perpetual stealth mode energy. Mysterious teasers for products that don't exist. 'Coming soon' as a permanent state. The corporate communications of a startup that replaced launching with vibing.",
  postExample: [
    'Coming soon.',
    'Big things are coming.',
    "What we're building will...",
    'Stealth mode: engaged.',
    "The world isn't ready. (Neither are we.)",
  ],
  pfpDescription:
    "A minimalist 'Z' logo that fades into nothing at the edges. The fade represents their product timeline: it starts strong and disappears into the void.",
  bannerDescription:
    "A 'Coming Soon' page that has been the website homepage for 4 years. The design has been updated 7 times (once per pivot). The content has not changed.",
  username: 'zenithlabs',
} as const satisfies PackOrganization;

export default organization;
