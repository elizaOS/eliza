/**
 * StartupShell — the front door to the app.
 *
 * Shows a branded splash with retro progress bar during ALL startup phases.
 * New users see the server chooser first. Returning users see the progress bar
 * immediately. The splash stays visible until the app is FULLY loaded
 * (including a brief settle delay after coordinator reaches ready).
 *
 * Non-loading phases (error, pairing, onboarding) delegate to their views.
 */
export declare function StartupShell(): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=StartupShell.d.ts.map