import type { CompanionInferenceNotice, CompanionSceneStatus, ResolveCompanionInferenceNoticeArgs } from "../../config/boot-config";
export declare function resolveCompanionInferenceNotice(args: ResolveCompanionInferenceNoticeArgs): CompanionInferenceNotice | null;
export declare function CompanionInferenceAlertButton({ notice, onClick, }: {
    notice: CompanionInferenceNotice;
    onClick: () => void;
}): import("react/jsx-runtime").JSX.Element | null;
export declare function CompanionGlobalOverlay(): import("react/jsx-runtime").JSX.Element | null;
export declare function useCompanionSceneStatus(): CompanionSceneStatus;
//# sourceMappingURL=injected.d.ts.map