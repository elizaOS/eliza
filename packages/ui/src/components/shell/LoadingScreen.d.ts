/**
 * Loading screen — NieR: Automata inspired loader with horizontal progress bar,
 * phase label, and percentage indicator.
 */
import type { StartupPhase } from "../../state";
interface LoadingScreenProps {
    phase?: StartupPhase;
    elapsedSeconds?: number;
    vrmUrl?: string;
}
export declare function LoadingScreen({ phase, elapsedSeconds, vrmUrl, }: LoadingScreenProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=LoadingScreen.d.ts.map