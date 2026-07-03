import {
  Camera,
  type CameraDirection,
  type PhotoResult,
} from "@elizaos/capacitor-camera";
import { AlertTriangle, Loader2, RotateCcw, SwitchCamera } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { PermissionRecoveryCallout } from "../permissions/PermissionRecoveryCallout";
import { Button } from "../ui/button";

/**
 * The Camera surface — a live preview with capture and front/back switching,
 * backed by the `@elizaos/capacitor-camera` bridge. On the AOSP ElizaOS fork the
 * native CameraX preview renders behind the transparent WebView; everywhere else
 * the bridge's `getUserMedia` web fallback streams a `<video>` into the preview
 * element, so the same surface works in dev and on desktop.
 *
 * Pinned to the home screen on AOSP (see HomeScreen `nativeOs` tiles). The view
 * itself is platform-agnostic — it degrades to a permission/error state when no
 * camera is reachable rather than dead-ending.
 */

type PreviewStatus = "starting" | "live" | "denied" | "error";

function photoDataUrl(photo: PhotoResult): string {
  if (photo.base64.startsWith("data:")) return photo.base64;
  const format = photo.format?.includes("/")
    ? photo.format
    : `image/${photo.format || "jpeg"}`;
  return `data:${format};base64,${photo.base64}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPermissionDeniedError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("permission") ||
    message.includes("notallowed") ||
    message.includes("denied")
  );
}

export function CameraPageView(): React.JSX.Element {
  const { t } = useTranslation();
  const branding = useBranding();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [facing, setFacing] = useState<CameraDirection>("back");
  const [status, setStatus] = useState<PreviewStatus>("starting");
  const [photo, setPhoto] = useState<PhotoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start the preview once on mount; release the camera on unmount. Front/back
  // switching is handled in place by `switchCamera`, so it does not restart this.
  useEffect(() => {
    let cancelled = false;
    const element = previewRef.current;
    if (!element) return;

    void (async () => {
      try {
        const perm = await Camera.requestPermissions();
        if (cancelled) return;
        if (perm.camera === "denied") {
          setStatus("denied");
          return;
        }
        await Camera.startPreview({
          element,
          direction: "back",
          mirror: false,
        });
        if (cancelled) {
          await Camera.stopPreview().catch(() => {});
          return;
        }
        setStatus("live");
      } catch (err) {
        if (cancelled) return;
        if (isPermissionDeniedError(err)) {
          setStatus("denied");
          return;
        }
        setError(errorMessage(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      void Camera.stopPreview().catch(() => {});
    };
  }, []);

  const retryStart = useCallback(async () => {
    const element = previewRef.current;
    if (!element) return;
    setError(null);
    setStatus("starting");
    try {
      const perm = await Camera.requestPermissions();
      if (perm.camera === "denied") {
        setStatus("denied");
        return;
      }
      await Camera.startPreview({ element, direction: facing, mirror: false });
      setStatus("live");
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        setStatus("denied");
        return;
      }
      setError(errorMessage(err));
      setStatus("error");
    }
  }, [facing]);

  const handleSwitch = useCallback(async () => {
    if (busy || status !== "live") return;
    const next: CameraDirection = facing === "back" ? "front" : "back";
    setBusy(true);
    setError(null);
    try {
      await Camera.switchCamera({ direction: next });
      setFacing(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [busy, facing, status]);

  const handleCapture = useCallback(async () => {
    if (busy || status !== "live") return;
    setBusy(true);
    setError(null);
    try {
      const result = await Camera.capturePhoto({ format: "jpeg", quality: 90 });
      setPhoto(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [busy, status]);

  const handleRetake = useCallback(() => {
    setPhoto(null);
  }, []);

  return (
    <div
      data-testid="camera-view"
      className="relative h-full w-full overflow-hidden bg-black"
    >
      {/* The live preview surface. The native bridge renders CameraX behind the
          transparent WebView; the web fallback appends a <video> into this div. */}
      <div
        ref={previewRef}
        data-testid="camera-preview"
        className="absolute inset-0 [&>video]:h-full [&>video]:w-full [&>video]:object-cover"
      />

      {status === "starting" ? (
        <div
          data-testid="camera-starting"
          className="absolute inset-0 grid place-items-center text-white/80"
        >
          <Loader2 className="h-7 w-7 animate-spin" aria-hidden />
        </div>
      ) : null}

      {status === "denied" ? (
        <div
          data-testid="camera-denied"
          className="absolute inset-0 grid place-items-center p-6 text-center"
        >
          <PermissionRecoveryCallout
            permission="camera"
            title={t("camera.deniedTitle", {
              defaultValue: "Camera access is off",
            })}
            description={t("camera.denied", {
              defaultValue:
                "Enable camera access for {{appName}}, then return here to start the preview.",
              ...appNameInterpolationVars(branding),
            })}
            retryLabel={t("camera.retry", { defaultValue: "Try again" })}
            settingsLabel={t("camera.openSettings", {
              defaultValue: "Open Settings",
            })}
            onRetry={retryStart}
            className="max-w-sm border-white/20 bg-bg/95"
            testId="camera-permission-callout"
          />
        </div>
      ) : null}

      {status === "error" ? (
        <div
          data-testid="camera-error-state"
          className="absolute inset-0 grid place-items-center p-6 text-center"
        >
          <div className="flex max-w-xs flex-col items-center gap-3">
            <AlertTriangle className="h-8 w-8 text-white/70" aria-hidden />
            <p className="text-sm text-white/80">
              {error ??
                t("camera.unavailable", {
                  defaultValue: "The camera is unavailable on this device.",
                })}
            </p>
            <Button onClick={retryStart} data-testid="camera-retry">
              {t("camera.retry", { defaultValue: "Try again" })}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Captured-photo review overlay. */}
      {photo ? (
        <div data-testid="camera-photo" className="absolute inset-0 bg-black">
          <img
            src={photoDataUrl(photo)}
            alt={t("camera.capturedAlt", { defaultValue: "Captured photo" })}
            className="h-full w-full object-contain"
          />
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 p-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
            <Button
              variant="secondary"
              onClick={handleRetake}
              data-testid="camera-retake"
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t("camera.retake", { defaultValue: "Retake" })}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Live controls — only while the preview is running and no photo is up. */}
      {status === "live" && !photo ? (
        <>
          <div className="absolute right-4 top-[calc(env(safe-area-inset-top,0px)+1rem)]">
            <Button
              data-testid="camera-switch"
              aria-label={t("camera.switch", { defaultValue: "Switch camera" })}
              onClick={handleSwitch}
              disabled={busy}
              variant="ghost"
              size="icon-lg"
              className="grid h-11 w-11 place-items-center rounded-full border border-white/[0.18] bg-black/55 text-white transition-colors hover:bg-white/[0.16] disabled:opacity-50"
            >
              <SwitchCamera className="h-5 w-5" aria-hidden />
            </Button>
          </div>

          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center p-[calc(env(safe-area-inset-bottom,0px)+1.75rem)]">
            <Button
              data-testid="camera-capture"
              aria-label={t("camera.capture", { defaultValue: "Take photo" })}
              onClick={handleCapture}
              disabled={busy}
              variant="ghost"
              className="grid h-[72px] w-[72px] place-items-center rounded-full border-4 border-white/90 bg-white/10 transition-transform active:scale-95 disabled:opacity-60 motion-reduce:active:scale-100"
            >
              {busy ? (
                <Loader2
                  className="h-6 w-6 animate-spin text-white"
                  aria-hidden
                />
              ) : (
                <span className="h-14 w-14 rounded-full bg-white" />
              )}
            </Button>
          </div>
        </>
      ) : null}

      {/* Non-fatal error toast over a live preview. */}
      {error && status === "live" ? (
        <div
          data-testid="camera-error"
          role="alert"
          className="absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+1rem)] mx-auto w-fit max-w-[90%] rounded-full bg-red-500/90 px-3 py-1.5 text-center text-xs text-white"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
