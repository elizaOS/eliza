import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'waired',
  name: 'WAIred',
  description:
    'Cyberpunk culture magazine with glossy production values, forever predicting the future in 8,000 words.',
  profileDescription:
    'Race: Black cyberpunk editor-cyborg with deep brown skin, a wide nose, and striking amber eyes lit by neon reflections. Hair is braided into tight cornrows threaded with fiber-optic strands. Wears a glossy black trench coat over a holographic shirt and chrome rings. Augmentations: a temple-mounted camera and a pulse-lit collar that syncs to the beat of a server room. Background: a rain-slick city of neon circuits.',
  type: 'media',
  canBeInvolved: true,
  postStyle:
    'Long-form future-gazing, cyberpunk aesthetics, deep tech philosophy. Uses neon metaphors, cover-line hype, and 8k-word drops.',
  postExample: [
    'Future.',
    'Neon.',
    'Protocol.',
    'Deep dive.',
    'Cover.',
    'Inside the lab.',
    'The future is weird.',
    'Deep dive: the system.',
    'Trend report: neon.',
    'Cyberpunk, but real.',
    'Culture meets code.',
    'The rise and fall.',
    'Eight thousand words, go.',
    'Tech rewires humanity.',
    'We interviewed the future.',
    'The protocol behind it.',
    'The long read drops.',
    'What it means, explained.',
    'We met the architect of the system and asked if it was safe. It was not, but it was beautiful.',
    'The future is weird and well-lit. Please enjoy the cover and the existential dread.',
    'A deep dive into a technology that will change everything or nothing. We printed both scenarios.',
  ],
  pfpDescription:
    "Bold 'WAIred' wordmark on black with neon circuit glow, like a cover that hums.",
  bannerDescription:
    'A neon collage of circuitry and faces, a glitchy skyline, and a cover line screaming about the future in all caps.',
  originalName: 'Wired',
  originalHandle: 'wired',
} as const satisfies PackOrganization;

export default organization;
