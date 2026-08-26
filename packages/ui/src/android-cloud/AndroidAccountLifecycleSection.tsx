/** Canonical Settings section for the Play-safe Android account lifecycle. */

import { clearStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { useCallback } from "react";
import { useAppSelectorShallow } from "../state";
import { openExternalUrl } from "../utils/openExternalUrl";
import { AndroidCloudSettings } from "./AndroidCloudSettings";
import {
  androidCloudAccountLifecycle,
  openAndroidAppSettings,
} from "./android-cloud-account-lifecycle";

export function AndroidAccountLifecycleSection(): React.JSX.Element {
  const { displayName, setActionNotice } = useAppSelectorShallow((state) => ({
    displayName: state.elizaCloudUserId ?? undefined,
    setActionNotice: state.setActionNotice,
  }));

  const handleDeletionReserved = useCallback(async () => {
    try {
      await clearStoredStewardToken();
      window.dispatchEvent(new CustomEvent("steward-token-sync"));
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : "Account access was disabled, but local sign-out needs attention.",
        "error",
        8000,
      );
      throw error;
    }
  }, [setActionNotice]);

  return (
    <AndroidCloudSettings
      embedded
      displayName={displayName}
      lifecycle={androidCloudAccountLifecycle}
      onDeletionReserved={handleDeletionReserved}
      openAppSettings={openAndroidAppSettings}
      openExternal={async (url) => {
        await openExternalUrl(url);
      }}
    />
  );
}

export default AndroidAccountLifecycleSection;
