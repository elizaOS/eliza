export { farcasterProfileProvider } from './profileProvider';
export { farcasterTimelineProvider } from './timelineProvider';
export { farcasterThreadProvider } from './threadProvider';

import { farcasterProfileProvider } from './profileProvider';
import { farcasterTimelineProvider } from './timelineProvider';
import { farcasterThreadProvider } from './threadProvider';

// Export all providers as an array for easy plugin registration
export const farcasterProviders = [
    farcasterProfileProvider,
    farcasterTimelineProvider,
    farcasterThreadProvider,
];
