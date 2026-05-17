/**
 * Drives the nprogress bar from react-router navigation.
 *
 * Strategy: when the location changes, start the bar and finish it shortly
 * after — the bar is a presence cue, not an in-flight indicator (the SPA
 * does its own data fetching with TanStack Query). The previous version
 * had `[]` deps and only fired once; this version reacts to every
 * navigation.
 */
export declare function NavigationProgress(): null;
//# sourceMappingURL=navigation-progress.d.ts.map