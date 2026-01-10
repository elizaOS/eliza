import { type Character } from '@elizaos/core';
import type { Cast } from './types';

export const formatCast = (cast: Cast) => {
  return `ID: ${cast.hash}
    From: ${cast.profile.name} (@${cast.profile.username})${cast.profile.username})${cast.inReplyTo ? `\nIn reply to: ${cast.inReplyTo.fid}` : ''}
Text: ${cast.text}`;
};

export const formatTimeline = (
  character: Character,
  timeline: Cast[]
) => `# ${character.name}'s Home Timeline
${timeline.map(formatCast).join('\n')}
`;
