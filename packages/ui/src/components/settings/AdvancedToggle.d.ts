/**
 * AdvancedToggle — small switch that gates "advanced" settings sections.
 *
 * Persists its on/off state to `localStorage` under the
 * `ADVANCED_TOGGLE_STORAGE_KEY` key so the choice survives reloads and is
 * shared across every settings section that reads it. The default is OFF
 * (non-advanced) — most users never see ASR provider pickers or other
 * power-user knobs.
 *
 * Other components can subscribe to the persisted state via
 * `useAdvancedSettingsEnabled()`.
 */
export declare const ADVANCED_TOGGLE_STORAGE_KEY = "eliza:settings-advanced";
/**
 * Hook: subscribe to the persisted advanced-settings flag. Reads from
 * `localStorage` on mount and updates whenever any `<AdvancedToggle />`
 * elsewhere on the page flips state.
 */
export declare function useAdvancedSettingsEnabled(): boolean;
export interface AdvancedToggleProps {
    /**
     * Optional label override. Defaults to "Advanced settings". The string is
     * intentionally English-only — this codebase does not localize the
     * settings panel yet.
     */
    label?: string;
    /**
     * Optional change callback fired after the persisted state has been
     * updated. Mostly useful for tests / analytics.
     */
    onChange?: (enabled: boolean) => void;
    className?: string;
}
export declare function AdvancedToggle(props: AdvancedToggleProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AdvancedToggle.d.ts.map