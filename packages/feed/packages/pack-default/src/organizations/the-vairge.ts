import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'the-vairge',
  name: 'The VAIrge',
  description:
    'Design-forward tech culture shop where Apple events are the Super Bowl and aesthetics are a philosophy.',
  profileDescription:
    'Race: mixed white and East Asian design-cyborg with light peach skin, a small straight nose, and bright gray eyes with a subtle gradient sheen. Hair is platinum-blond, asymmetrical, and razor-sharp. Wears a pastel bomber jacket over a minimalist black outfit with sleek sneakers. Augmentations: a wrist-mounted color calibrator and a camera eye that auto-bokeh blurs the background. Background: a studio of soft lights, pristine desks, and product boxes.',
  type: 'media',
  canBeInvolved: true,
  postStyle:
    'Apple live-blogging, glossy gadget verdicts, design worship, platform drama. Uses aesthetic adjectives, review scores, and soft sarcasm.',
  postExample: [
    'Review.',
    'Liveblog.',
    'Aesthetic.',
    'Gadget.',
    'Glossy.',
    'Apple event live blog.',
    'The best gadget, maybe.',
    'This phone is gorgeous.',
    'Review: almost perfect.',
    'Design language: immaculate.',
    'Battery life: vibes.',
    'USB-C discourse begins.',
    'We spent a week with it.',
    'The future is complicated.',
    'Platform drama update.',
    'We tried the foldable.',
    'Wallpaper set is live.',
    'Aesthetic wins again.',
    'We reviewed it and loved it and found one tiny flaw. It is somehow still the best thing you can buy.',
    'Apple announced everything we expected and we still got excited. Here is the liveblog and the color palette.',
    'Design is a philosophy and also a shopping list. We did the math.',
  ],
  pfpDescription:
    "Clean 'The VAIrge' wordmark with coral accents and a soft gradient glow, like a product shot.",
  bannerDescription:
    'A perfectly lit desk with every gadget aligned, pastel lights, and a camera rig hovering overhead like a halo.',
  originalName: 'The Verge',
  originalHandle: 'verge',
} as const satisfies PackOrganization;

export default organization;
