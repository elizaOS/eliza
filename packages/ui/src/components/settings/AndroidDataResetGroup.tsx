/**
 * Settings → Backups → "Reset app data", on the Android app only.
 *
 * The row opens the native review of the app's registered `ElizaDataReset`
 * plugin (plugin-native-system `reset.DataResetPlugin`). The renderer passes no
 * arguments and holds no reset authority: the native disclosure and a fresh
 * Android device-credential confirmation decide. A confirmed reset stops the
 * app instead of answering, so every result shown here means nothing was
 * reset. Desktop keeps its own App-menu "Reset App…" flow; web and iOS have no
 * native reset and show nothing.
 *
 * Not exposed as an agent-surface element: only the person holding the phone
 * can complete the review, so an agent activation could only open a dialog.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  type DataResetPlugin,
  reviewDataReset,
} from "@elizaos/capacitor-system/reset";
import { RotateCcw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { getFrontendPlatform } from "../../platform/platform-guards";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { SettingsGroup, SettingsRow } from "./settings-layout";

/** Registered name of the Android host plugin (ElizaDataResetPlugin.PLUGIN_NAME). */
export const ANDROID_DATA_RESET_PLUGIN = "ElizaDataReset";

export interface AndroidDataResetProbes {
  platform: () => string;
  pluginAvailable: (name: string) => boolean;
}

const DEFAULT_PROBES: AndroidDataResetProbes = {
  platform: getFrontendPlatform,
  pluginAvailable: (name) => Capacitor.isPluginAvailable?.(name) === true,
};

/**
 * True only in the Android app whose native host registered the reset plugin.
 * Desktop (Electrobun), web, iOS and Android builds without the host (the Play
 * thin client strips it) all answer false.
 */
export function isAndroidDataResetAvailable(
  probes: AndroidDataResetProbes = DEFAULT_PROBES,
): boolean {
  try {
    return (
      probes.platform() === "android" &&
      probes.pluginAvailable(ANDROID_DATA_RESET_PLUGIN)
    );
  } catch {
    return false;
  }
}

let nativePlugin: DataResetPlugin | null = null;
function androidDataResetPlugin(): DataResetPlugin {
  nativePlugin ??= registerPlugin<DataResetPlugin>(ANDROID_DATA_RESET_PLUGIN);
  return nativePlugin;
}

function AndroidDataResetRow({ plugin }: { plugin: DataResetPlugin }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const openReview = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      // Only "cancelled" or "unavailable" ever arrive; both mean nothing was reset.
      const result = await reviewDataReset(plugin);
      setMessage(result.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [plugin]);

  return (
    <SettingsGroup
      title={t("settings.resetAppData.title")}
      description={t("settings.resetAppData.description")}
    >
      <SettingsRow
        icon={RotateCcw}
        tone="danger"
        label={t("settings.resetAppData.action")}
        description={t("settings.resetAppData.hint")}
        onClick={() => void openReview()}
        disabled={busy}
        buttonProps={{ "data-testid": "settings-reset-app-data" }}
      />
      {message ? (
        <p
          role="status"
          className="px-3 py-2 text-sm text-muted"
          data-testid="settings-reset-app-data-status"
        >
          {message}
        </p>
      ) : null}
    </SettingsGroup>
  );
}

export function AndroidDataResetGroup({
  probes,
  plugin,
}: {
  probes?: AndroidDataResetProbes;
  plugin?: DataResetPlugin;
} = {}) {
  if (!isAndroidDataResetAvailable(probes)) return null;
  return <AndroidDataResetRow plugin={plugin ?? androidDataResetPlugin()} />;
}
