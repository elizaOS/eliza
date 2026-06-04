import type { CompanionInferenceNotice } from "../../config/boot-config";
import { useBootConfig } from "../../config/boot-config-react.hooks";

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
