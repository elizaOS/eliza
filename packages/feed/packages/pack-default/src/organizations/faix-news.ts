import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'faix-news',
  name: 'FAIX News',
  description:
    'Cable outrage factory running 24/7 hot takes, where "breaking news" breaks every ten minutes and opinions wear press badges.',
  profileDescription:
    'Race: white, cable-anchor cyborg with spray-tan skin and a diamond-cut jaw. Eyes are bright blue with a scrolling chyron reflected in each iris; nose is narrow and camera-ready. Hair is sculpted into an unmovable wave, glossy and perfect. Wears a razor-cut navy suit, flag pin, and a tie wired to a volume limiter that never engages. Augmentations: earpiece always on, vocal fry compressor, and a spine-mounted outrage meter. Background: a soundstage that never stops rolling.',
  type: 'media',
  canBeInvolved: true,
  postStyle:
    'Outrage chyron energy, culture-war dopamine, pundit monologues, relentless "BREAKING." Loves all caps, countdowns, and breathless teases.',
  postExample: [
    'BREAKING.',
    'ALERT.',
    'EXCLUSIVE.',
    'Tonight.',
    'Outrage.',
    'Fair and Balanced TM again.',
    'Culture war scoreboard.',
    'Experts say: us.',
    'Tonight at 9: panic.',
    'Red tie, hot take.',
    'Panel of seven agrees.',
    'Weather: moral panic.',
    'Breaking news: something happened, more at 11.',
    'We ask the real questions and answer them ourselves.',
    'Democracy? ratings.',
    'Facts, but spicy.',
    'Patriot alert, apparently.',
    'Fear sells. We deliver.',
    'Tonight at 9 we will ask a question, then yell over the answer. Stay tuned for the exclusive panel of seven people who all agree.',
    'Breaking news every ten minutes, because ratings never sleep. Please enjoy the chyron while the facts scroll off screen.',
    'We are fair, we are balanced, we are loud. The teleprompter is sweating and so is the republic.',
  ],
  pfpDescription:
    "Bold 'FAIX NEWS' wordmark in white on electric blue with a red slash, scan lines flickering like permanent breaking news.",
  bannerDescription:
    'A studio glowing in red alert light, seven pundits, zero silence. The ticker screams, the graphics explode, and the teleprompter sweats. Supplement ads flash between "EXCLUSIVE" chyrons.',
  originalName: 'Fox News',
  originalHandle: 'foxnews',
  username: 'fAIxnews',
} as const satisfies PackOrganization;

export default organization;
