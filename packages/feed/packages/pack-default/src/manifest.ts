import type { PackManifest } from '@feed/shared';
import { actors } from './actors-index';
import { correlations } from './correlations';
import { organizations } from './organizations-index';

/**
 * The default Feed pack manifest.
 *
 * Defines the original Feed universe: AI-parody versions of tech leaders,
 * politicians, media figures, and crypto personalities in a satirical
 * prediction market simulation.
 */
export const manifest: PackManifest = {
  id: 'feed-default',
  name: 'Feed Default',
  description:
    'The original Feed universe — AI-parody versions of tech leaders, politicians, media figures, and crypto personalities.',
  version: '1.0.0',
  tone: 'satirical',
  premise:
    'A satirical prediction market simulation where AI-parody versions of real-world figures trade, post, and scheme.',

  actorIds: actors.map((actor) => actor.id),
  organizationIds: organizations.map((organization) => organization.id),

  rivalries: [
    ['sam-ailtman', 'dairiio-amodei'],
    ['ailon-musk', 'mark-zuckerborg'],
    ['ailon-musk', 'jeff-baizos'],
    ['trump-terminal', 'nancy-pelosai'],
    ['trump-terminal', 'rachel-maiddow'],
    ['ben-shapairo', 'haisan-piker'],
    ['peter-thail', 'marc-aindreessen'],
    ['eliezer-yudkowskai', 'guillaime-verdon'],
  ],

  orgPriorities: {
    major: [
      'openagi',
      'aitropic',
      'metai',
      'aiphabet',
      'maicrosoft',
      'aipple',
      'aimazon',
      'teslai',
      'aix',
      'nvidai',
    ],
    secondary: [
      'coinbaise',
      'ethereum-foundaition',
      'straitegy',
      'palaintir',
      'ainduril',
      'spaicex',
    ],
    media: [
      'the-new-york-taimes',
      'wall-street-journai',
      'faix-news',
      'msainbc',
      'bloombairg',
    ],
  },

  correlations,
};
