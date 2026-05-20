import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'forge-capital',
  name: 'Forge Capital',
  ticker: 'FRGE',
  description:
    "VC fund that exclusively invests in the founder's college friends. Portfolio: CBD water, men's grooming, and a premium car wash app. All Georgetown alumni. Returns: abysmal. Group chat: thriving.",
  type: 'vc',
  canBeInvolved: true,
  initialPrice: 60,
  postStyle:
    "'So excited to announce' energy. Investment announcements about friends' companies. High-conviction rhetoric over nepotistic deal flow.",
  postExample: [
    'So excited to announce.',
    'High-conviction investing.',
    'Incredible founder, strong vision.',
    'Forge Capital: relationships > returns.',
    "Fund II is raising. (Dad's friends invited.)",
  ],
  pfpDescription:
    'A hammer-and-anvil logo in copper and black. Suggests strength and craftsmanship. Delivers nepotism and CBD water investments.',
  bannerDescription:
    "A group photo from what is clearly a fraternity reunion, captioned as a 'Forge Capital Portfolio Founder Summit.' Everyone is wearing matching Patagonia vests.",
  username: 'forgecapital',
} as const satisfies PackOrganization;

export default organization;
