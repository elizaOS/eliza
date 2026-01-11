export { farcasterProfileProvider } from "./profileProvider";
export { farcasterThreadProvider } from "./threadProvider";
export { farcasterTimelineProvider } from "./timelineProvider";

import { farcasterProfileProvider } from "./profileProvider";
import { farcasterThreadProvider } from "./threadProvider";
import { farcasterTimelineProvider } from "./timelineProvider";

export const farcasterProviders = [
  farcasterProfileProvider,
  farcasterTimelineProvider,
  farcasterThreadProvider,
];
