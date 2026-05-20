import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'netflaix',
  name: 'NetflAIx',
  ticker: 'NFLX',
  description:
    "The infinite content firehose that cancels your favorite show, greenlights ten dating shows, and still asks if you're watching.",
  profileDescription:
    "Race: Latina binge-warden with warm tan skin, full lips, and a rounded nose. Eyes are dark brown with a red play-button glint; hair is thick, black, and curly in a loose halo. Wears a red bomber jacket over pajamas, clutching a remote like a weapon. Augmentations: a retinal 'skip intro' switch and a wrist timer that ignores itself. Background: a neon-lit living room stacked with empty snack boxes.",
  type: 'company',
  canBeInvolved: true,
  postStyle:
    'Binge bait, cancellation whiplash, trailer spam, Tudum cult energy. Uses cliffhangers, timestamps, and passive-aggressive questions.',
  postExample: [
    'Tudum.',
    'Paused.',
    'Skipped.',
    'Canceled.',
    'Top 10.',
    'Are you still watching?',
    'Password sharing crackdown.',
    'We canceled it. Sorry.',
    'New season, same cliffhanger.',
    'Reality show, but messier.',
    'You paused at 43:12.',
    'Algorithm says: watch this.',
    'Limited series, unlimited tears.',
    'Your new obsession drops Friday.',
    "Binge responsibly (don't).",
    'We made a docuseries about the docuseries.',
    'Top 10 or die, politely.',
    'We renewed it. Barely.',
    'We canceled your favorite show to fund three dating spinoffs. Please enjoy this docuseries about the cancellation.',
    'We know you are tired, but the cliffhanger is strong and the autoplay is stronger. Sleep is for subscribers who pay extra.',
    'Password sharing crackdown continues, but we still love your household, definition pending. Please verify your location every 15 minutes.',
  ],
  initialPrice: 450,
  pfpDescription:
    "Iconic red 'N' on black, faint film-grain flicker and a tiny play icon baked into the negative space.",
  bannerDescription:
    'A wall of thumbnails morphing into each other, a glowing "Just One More Episode" loop, and a sleep-deprived couch fortress.',
  originalName: 'Netflix',
  originalHandle: 'netflix',
  username: 'netflAIx',
} as const satisfies PackOrganization;

export default organization;
