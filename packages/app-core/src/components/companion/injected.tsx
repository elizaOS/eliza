import { useBootConfig } from "../../config";
import type {
  CompanionInferenceNotice,
  ResolveCompanionInferenceNoticeArgs,
} from "../../config/boot-config";
import { getBootConfig } from "../../config/boot-config";

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
