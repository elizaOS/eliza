import { useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import { useTranslation } from "../../state/TranslationContext";
import { openExternalUrl } from "../../utils";
import { XRPairingPanel } from "../connectors/XRPairingPanel";
import { Button } from "../ui/button";

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
        className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
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
          className="text-xs text-muted hover:text-txt"
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
    // The app-xr PWA lives at the agent origin with /api/xr prefix stripped
    // For local dev: it's a separate Vite server on port 5173
    // In production: it's served from the agent
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
    <div className="rounded-sm border border-border/40 bg-card/40 p-4">
      <p className="mb-3 text-xs text-muted leading-relaxed">
        {t("xrsettings.webxrDesc", {
          defaultValue:
            "Open the XR app in Chrome to use WebXR on desktop. Chrome supports WebXR with the Immersive Web Emulator extension for simulator testing. On a real headset, use the pairing code or QR code above.",
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={launchRef}
          variant="default"
          size="sm"
          className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
          onClick={launch}
          {...launchAgentProps}
        >
          {launchLabel}
        </Button>
        <XRSimulatorEmbed />
      </div>
    </div>
  );
}

export function XRSettingsSection() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          {t("xrsettings.intro", {
            defaultValue:
              "Connect a Quest 3 or XReal headset, or run WebXR in Chrome on desktop. The agent can open, close, resize, and switch views on any connected device via voice or text commands.",
          })}
        </p>
      </div>

      <XRPairingPanel />

      <div className="border-t border-border/40 pt-5">
        <h3 className="mb-3 text-sm font-semibold text-txt">
          {t("xrsettings.desktopWebxr", { defaultValue: "Desktop WebXR" })}
        </h3>
        <WebXRLauncher />
      </div>

      <div className="border-t border-border/40 pt-5">
        <h3 className="mb-3 text-sm font-semibold text-txt">
          {t("xrsettings.platforms", { defaultValue: "Platforms" })}
        </h3>
        <div className="space-y-2">
          {[
            {
              name: "Quest 3",
              status: t("xrsettings.statusApkAvailable", {
                defaultValue: "APK available",
              }),
              detail: t("xrsettings.questDetail", {
                defaultValue: "Bubblewrap TWA — android/quest/",
              }),
            },
            {
              name: "XReal Air / Air 2",
              status: t("xrsettings.statusApkAvailable", {
                defaultValue: "APK available",
              }),
              detail: t("xrsettings.xrealDetail", {
                defaultValue: "Native Android + WebView — android/xreal/",
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
            <div key={p.name} className="flex items-center gap-3 text-xs">
              <span className="w-28 shrink-0 font-medium text-txt">
                {p.name}
              </span>
              <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-success">
                {p.status}
              </span>
              <span className="text-muted">{p.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
