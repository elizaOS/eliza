import type {
  CompanionInferenceNotice,
  CompanionSceneStatus,
  ResolveCompanionInferenceNoticeArgs,
} from "../../config/boot-config";
import { getBootConfig } from "../../config/boot-config";
import { useBootConfig } from "../../config/boot-config-react";

export function resolveCompanionInferenceNotice(
  args: ResolveCompanionInferenceNoticeArgs,
): CompanionInferenceNotice | null {
  return getBootConfig().resolveCompanionInferenceNotice?.(args) ?? null;
}

export function CompanionInferenceAlertButton({
  notice,
  onClick,
}: {
  notice: CompanionInferenceNotice;
  onClick: () => void;
}) {
  const {
    companionInferenceAlertButton: CompanionInferenceAlertButtonComponent,
  } = useBootConfig();
  return CompanionInferenceAlertButtonComponent ? (
    <CompanionInferenceAlertButtonComponent notice={notice} onClick={onClick} />
  ) : null;
}

export function CompanionGlobalOverlay() {
  const { companionGlobalOverlay: CompanionGlobalOverlayComponent } =
    useBootConfig();
  return CompanionGlobalOverlayComponent ? (
    <CompanionGlobalOverlayComponent />
  ) : null;
}

const DEFAULT_COMPANION_SCENE_STATUS: CompanionSceneStatus = {
  avatarReady: false,
  teleportKey: "",
};

export function useCompanionSceneStatus(): CompanionSceneStatus {
  return (
    getBootConfig().useCompanionSceneStatus?.() ??
    DEFAULT_COMPANION_SCENE_STATUS
  );
}
