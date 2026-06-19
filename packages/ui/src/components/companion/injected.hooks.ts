import type {
  CompanionInferenceNotice,
  CompanionSceneStatus,
  ResolveCompanionInferenceNoticeArgs,
} from "../../config/boot-config";
import { getBootConfig } from "../../config/boot-config";

export function resolveCompanionInferenceNotice(
  args: ResolveCompanionInferenceNoticeArgs,
): CompanionInferenceNotice | null {
  return getBootConfig().resolveCompanionInferenceNotice?.(args) ?? null;
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
