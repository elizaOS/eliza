import type { OnboardingClientLike as ClientLike, HistoryLike, StorageLike } from "./types";
export declare function isForceFreshOnboardingEnabled(storage?: StorageLike | null): boolean;
export declare function enableForceFreshOnboarding(storage?: StorageLike | null): void;
export declare function clearForceFreshOnboarding(storage?: StorageLike | null): void;
export declare function applyForceFreshOnboardingReset(args?: {
    url?: URL;
    storage?: StorageLike | null;
    history?: HistoryLike | null;
}): boolean;
export declare function installForceFreshOnboardingClientPatch(client: ClientLike, storage?: StorageLike | null): () => void;
//# sourceMappingURL=onboarding-reset.d.ts.map