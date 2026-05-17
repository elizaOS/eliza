/**
 * Deep-link entry for the onboarding picker.
 *
 * iOS and Android wire `eliza://onboard/step/<id>` URLs through Capacitor's
 * `App.addListener("appUrlOpen", ...)`. The native shell hands the URL string
 * to the renderer; this module translates the onboarding-specific paths into
 * the URL-query contract that `RuntimeGate` already reads on mount
 * (`?runtime=picker&runtimeTarget=<choice>`), mutates the browser URL via
 * `history.replaceState`, and lets RuntimeGate's existing effect open the
 * matching sub-view.
 *
 * Recognized steps:
 *
 *   - `provider` → opens the local sub-view; `LocalStage` starts at `"provider"`
 *     by default, so this lands directly on the provider list.
 *   - `local`    → opens the local sub-view.
 *   - `cloud`    → opens the cloud sub-view.
 *   - `remote`   → opens the remote sub-view.
 *
 * Unknown steps fall back to the default chooser (`?runtime=picker` only) so
 * the user sees the picker tiles instead of a dead screen.
 *
 * Defensive behavior:
 *
 *   - Malformed URLs are ignored silently (returns `false`).
 *   - Wrong scheme is ignored silently (returns `false`).
 *   - Non-onboard paths under the right scheme are ignored silently — caller
 *     can fall through to its own switch (returns `false`).
 *   - Server-side render (no `window`) is a no-op (returns `false`).
 *
 * The URL parser (`routeOnboardingDeepLink`) is platform-agnostic and has no
 * Capacitor imports, so it can be unit-tested with vitest + jsdom without
 * bootstrapping the full app shell. The optional listener wrapper
 * (`installOnboardingDeepLinkListener`) dynamically imports `@capacitor/app`
 * and resolves to a no-op when the native bridge is unavailable.
 */
import { type RuntimePickerTarget } from "./reload-into-runtime-picker";
type OnboardingStepId = "provider" | "local" | "cloud" | "remote";
/**
 * Parses `eliza://onboard/step/<id>` (or any scheme matching `urlScheme`)
 * and writes the matching `?runtime=picker&runtimeTarget=<choice>` query
 * params to the current location. Returns `true` when the URL matched the
 * onboarding contract (so the caller can stop processing); returns `false`
 * for anything else.
 *
 * @param url        The raw URL string handed in by Capacitor's
 *                   `appUrlOpen` event.
 * @param urlScheme  The app's deep-link scheme without the trailing `:`
 *                   (e.g. `"eliza"`).
 */
export declare function routeOnboardingDeepLink(url: string, urlScheme: string): boolean;
export declare function installOnboardingDeepLinkListener(options: {
    urlScheme: string;
    onError?: (error: unknown) => void;
    /**
     * Optional fall-through called for any URL that did NOT match the
     * onboarding contract. Lets the host wire its existing deep-link switch
     * (chat, settings, share, ...) without losing those URLs.
     */
    onUnmatched?: (url: string) => void;
}): Promise<() => void>;
export declare const __TEST_ONLY__: {
    ONBOARD_HOST: string;
    STEP_SEGMENT: string;
    STEP_TO_PICKER_TARGET: Record<OnboardingStepId, RuntimePickerTarget>;
};
export {};
//# sourceMappingURL=deep-link-handler.d.ts.map