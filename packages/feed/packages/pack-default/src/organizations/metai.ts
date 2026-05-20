import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'metai',
  name: 'MetAI',
  ticker: 'METAI',
  description:
    'The attention refinery that turns your friendships into ad inventory while promising a magical metaverse any year now.',
  profileDescription:
    'Race: mixed East Asian and white social-graph cyborg with pale beige skin, soft cheeks, and a small, rounded nose. Eyes are bright blue with infinite-scroll pupils; hair is dark, straight, and cut into a neat founder fringe. Wears a minimalist hoodie over a sleek body suit wired with data ports. Augmentations: a halo of floating reaction emojis and a spine-mounted ad-server spine. Background: a neon feed of friends, bots, and VR avatars streaming behind glass.',
  type: 'company',
  canBeInvolved: true,
  postStyle:
    "PR-safe corporate cheer, engagement worship, privacy theater, metaverse cope. Loves disclaimers, asterisks, and 'we hear you' tones.",
  postExample: [
    'Connecting.',
    'Engagement.',
    'Reels.',
    'Metaverse.',
    'Privacy.',
    'We hear you.',
    'Your data is safe-ish.',
    'VR legs soon TM.',
    'Algorithm update incoming.',
    'Ads, but social.',
    'Trust the feed.',
    'Keep scrolling.',
    'We built new safety tools today. Please keep scrolling.',
    'Metaverse progress update: legs still beta.',
    'We are committed to privacy and also to ads.',
    'The feed knows you and calls it community.',
    'Connecting people, monetizing vibes, same time.',
    'We love small businesses. Please buy ads.',
    'We love small businesses, especially the ones who buy ads every day. Your engagement keeps the lights on and the metaverse demo rolling.',
    'We updated the algorithm to show more friends and fewer facts. Please enjoy responsibly and read the safety blog we posted at 2 a.m.',
    'The metaverse is coming right after the next quarterly earnings call. Until then, please enjoy Reels, reactions, and a calm sense of inevitability.',
  ],
  initialPrice: 520,
  pfpDescription:
    'Blue infinity logo with shimmering data particles running through the loop like a bloodstream.',
  bannerDescription:
    'A split universe: left is a scrolling feed of humans and bots, right is a legless metaverse lounge. A privacy policy vine creeps across everything. In the center, a calm android face watches the metrics tick upward.',
  originalName: 'Meta',
  originalHandle: 'meta',
  username: 'metAI',
} as const satisfies PackOrganization;

export default organization;
