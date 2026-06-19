import { useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { openExternalUrl } from "../../utils";
import { XRPairingPanel } from "../connectors/XRPairingPanel";
import { Button } from "../ui/button";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

function XRSimulatorEmbed() {
  const { t } = useTranslation();
  const [showEmbed, setShowEmbed] = useState(false);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  useEffect(() => {
    const base = client.baseUrl || window.location.origin;
    setEmbedUrl(`${base}/api/xr/connect`);
  }, []);

  const previewLabel = t("xrsettings.previewConnect", {
    defaultValue: "Preview connect page",
  });
  const { ref: previewRef, agentProps: previewAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "xr-preview-connect",
      role: "button",
      label: previewLabel,
      group: "xr-desktop",
      status: showEmbed ? "active" : "inactive",
      onActivate: () => setShowEmbed(true),
    });
  const { ref: closePreviewRef, agentProps: closePreviewAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "xr-close-preview",
      role: "button",
      label: t("xrsettings.closeConnectPreview", {
        defaultValue: "Close XR connect preview",
      }),
      group: "xr-desktop",
      onActivate: () => setShowEmbed(false),
    });

  if (!showEmbed) {
    return (
      <Button
        ref={previewRef}
        variant="outline"
        size="sm"
        className="h-11 rounded-md px-4 text-sm font-semibold"
        onClick={() => setShowEmbed(true)}
        {...previewAgentProps}
      >
        {previewLabel}
      </Button>
    );
  }

  return (
    <div className="overflow-hidden rounded-sm border border-border/50">
      <div className="flex items-center justify-between border-b border-border/40 bg-muted/20 px-3 py-1.5">
        <span className="text-xs font-medium text-muted">
          {t("xrsettings.connectPreview", {
            defaultValue: "XR Connect Preview",
          })}
        </span>
        <button
          ref={closePreviewRef}
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-sm text-muted hover:bg-surface hover:text-txt"
          onClick={() => setShowEmbed(false)}
          {...closePreviewAgentProps}
        >
          ✕
        </button>
      </div>
      {embedUrl ? (
        <iframe
          src={embedUrl}
          title={t("xrsettings.connectPageTitle", {
            defaultValue: "XR Connect Page",
          })}
          className="w-full"
          style={{ height: 380, border: "none" }}
          sandbox="allow-scripts allow-same-origin"
        />
      ) : null}
    </div>
  );
}

function WebXRLauncher() {
  const { t } = useTranslation();
  const launch = useCallback(() => {
    const base = client.baseUrl || window.location.origin;
    // Local dev serves the XR PWA from a separate Vite server on port 5173.
    const xrAppUrl = base.replace(/:(\d+)$/, (_, port) => {
      const p = parseInt(port, 10);
      return `:${p === 31337 ? 5173 : p}`;
    });
    void openExternalUrl(xrAppUrl);
  }, []);

  const launchLabel = t("xrsettings.launchInBrowser", {
    defaultValue: "Launch XR app in browser",
  });
  const { ref: launchRef, agentProps: launchAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "xr-launch-browser",
      role: "button",
      label: launchLabel,
      group: "xr-desktop",
      onActivate: launch,
    });

  return (
    <SettingsRow
      label={t("xrsettings.desktopWebxr", { defaultValue: "Desktop WebXR" })}
      description={t("xrsettings.webxrDesc", {
        defaultValue:
          "Open the XR app in Chrome for desktop WebXR. On a headset, use the pairing/QR code above.",
      })}
      stacked
    >
      <div className="flex flex-wrap gap-2">
        <Button
          ref={launchRef}
          variant="default"
          size="sm"
          className="h-11 rounded-md px-4 text-sm font-semibold"
          onClick={launch}
          {...launchAgentProps}
        >
          {launchLabel}
        </Button>
        <XRSimulatorEmbed />
      </div>
    </SettingsRow>
  );
}

export function XRSettingsSection() {
  const { t } = useTranslation();
  return (
    <SettingsStack>
      <p className="px-1 text-sm text-muted">
        {t("xrsettings.intro", {
          defaultValue:
            "Connect a Quest 3 or XReal headset, or run WebXR in Chrome on desktop.",
        })}
      </p>

      <XRPairingPanel />

      <SettingsGroup
        title={t("xrsettings.desktopWebxr", { defaultValue: "Desktop WebXR" })}
      >
        <WebXRLauncher />
      </SettingsGroup>

      <SettingsGroup
        title={t("xrsettings.platforms", { defaultValue: "Platforms" })}
      >
        {[
          {
            name: "Quest 3",
            status: t("xrsettings.statusApkAvailable", {
              defaultValue: "APK available",
            }),
            detail: t("xrsettings.questDetail", {
              defaultValue: "Bubblewrap TWA",
            }),
          },
          {
            name: "XReal Air / Air 2",
            status: t("xrsettings.statusApkAvailable", {
              defaultValue: "APK available",
            }),
            detail: t("xrsettings.xrealDetail", {
              defaultValue: "Native Android + WebView",
            }),
          },
          {
            name: "Browser (WebXR)",
            status: t("xrsettings.statusFullSupport", {
              defaultValue: "Full support",
            }),
            detail: t("xrsettings.browserDetail", {
              defaultValue: "Chrome + Immersive Web Emulator for simulator",
            }),
          },
          {
            name: "iOS Safari",
            status: t("xrsettings.statusPartialWebxr", {
              defaultValue: "Partial WebXR",
            }),
            detail: t("xrsettings.iosDetail", {
              defaultValue:
                "DOM overlay on Safari 15.4+ — mic + camera supported",
            }),
          },
        ].map((p) => (
          <SettingsRow
            key={p.name}
            label={p.name}
            description={p.detail}
            trailing={
              <span className="shrink-0 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs text-success">
                {p.status}
              </span>
            }
          />
        ))}
      </SettingsGroup>
    </SettingsStack>
  );
}
