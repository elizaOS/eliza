import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import { openExternalUrl } from "../../utils";
import { XRPairingPanel } from "../connectors/XRPairingPanel";
import { Button } from "../ui/button";

function XRSimulatorEmbed() {
  const [showEmbed, setShowEmbed] = useState(false);
  const [embedUrl, setEmbedUrl] = useState<string | null>(null);

  useEffect(() => {
    const base = client.baseUrl || window.location.origin;
    setEmbedUrl(`${base}/api/xr/connect`);
  }, []);

  if (!showEmbed) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
        onClick={() => setShowEmbed(true)}
      >
        Preview connect page
      </Button>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/50">
      <div className="flex items-center justify-between border-b border-border/40 bg-muted/20 px-3 py-1.5">
        <span className="text-xs font-medium text-muted">
          XR Connect Preview
        </span>
        <button
          type="button"
          className="text-xs text-muted hover:text-txt"
          onClick={() => setShowEmbed(false)}
        >
          ✕
        </button>
      </div>
      {embedUrl ? (
        <iframe
          src={embedUrl}
          title="XR Connect Page"
          className="w-full"
          style={{ height: 380, border: "none" }}
          sandbox="allow-scripts allow-same-origin"
        />
      ) : null}
    </div>
  );
}

function WebXRLauncher() {
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

  return (
    <div className="rounded-lg border border-border/40 bg-card/40 p-4">
      <p className="mb-3 text-xs text-muted leading-relaxed">
        Open the XR app in Chrome to use WebXR on desktop. Chrome supports WebXR
        with the <em>Immersive Web Emulator</em> extension for simulator
        testing. On a real headset, use the pairing code or QR code above.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="default"
          size="sm"
          className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
          onClick={launch}
        >
          Launch XR app in browser
        </Button>
        <XRSimulatorEmbed />
      </div>
    </div>
  );
}

export function XRSettingsSection() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          Connect a Quest 3 or XReal headset, or run WebXR in Chrome on desktop.
          The agent can open, close, resize, and switch views on any connected
          device via voice or text commands.
        </p>
      </div>

      <XRPairingPanel />

      <div className="border-t border-border/40 pt-5">
        <h3 className="mb-3 text-sm font-semibold text-txt">Desktop WebXR</h3>
        <WebXRLauncher />
      </div>

      <div className="border-t border-border/40 pt-5">
        <h3 className="mb-3 text-sm font-semibold text-txt">Platforms</h3>
        <div className="space-y-2">
          {[
            {
              name: "Quest 3",
              status: "APK available",
              detail: "Bubblewrap TWA — android/quest/",
            },
            {
              name: "XReal Air / Air 2",
              status: "APK available",
              detail: "Native Android + WebView — android/xreal/",
            },
            {
              name: "Browser (WebXR)",
              status: "Full support",
              detail: "Chrome + Immersive Web Emulator for simulator",
            },
            {
              name: "iOS Safari",
              status: "Partial WebXR",
              detail: "DOM overlay on Safari 15.4+ — mic + camera supported",
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
