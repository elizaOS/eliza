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
 *
 * Hosts pass `ports` to decide where an explicit capture goes (keep it in their
 * own media store, hand it to a scan review or a question). Without ports a
 * capture is only previewed; nothing is kept or handed off implicitly. The
 * lock-screen secure camera stays a system surface.
 */
import {
  Camera,
  type CameraDirection,
  type CameraHostPorts,
  type CameraKeepOutcome,
  type CameraSession,
  type CameraStartOutcome,
  cameraAccessDenied,
  captureOperationId,
  createCameraSession,
  keepCapture,
  type PhotoResult,
  restartAfterResume,
} from "@elizaos/capacitor-camera";
import { AlertTriangle, Loader2, RotateCcw, SwitchCamera } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appNameInterpolationVars } from "../../config/branding-base";
import { useBranding } from "../../config/branding-react.hooks";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { PermissionRecoveryCallout } from "../permissions/PermissionRecoveryCallout";
import { Button } from "../ui/button";

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

/** Only an explicit camera denial gets the settings recovery state. */
function isPermissionDeniedError(err: unknown): boolean {
  return cameraAccessDenied(err) === "camera";
}

const UNAVAILABLE = "Camera is not available on this device.";

export interface CameraPageViewProps {
  /** Host capture/storage ports; see `CameraHostPorts`. */
  ports?: CameraHostPorts;
}

export function CameraPageView({
  ports,
}: CameraPageViewProps = {}): React.JSX.Element {
  const { t } = useTranslation();
  const branding = useBranding();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [facing, setFacing] = useState<CameraDirection>("back");
  const [status, setStatus] = useState<PreviewStatus>("starting");
  const [photo, setPhoto] = useState<PhotoResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One operation identity per capture, so a retried Keep resolves the same save.
  const [operationId, setOperationId] = useState<string | null>(null);
  const [kept, setKept] = useState<CameraKeepOutcome | null>(null);
  const [handing, setHanding] = useState(false);
  const statusRef = useRef<PreviewStatus>("starting");
  const disposedRef = useRef(false);
  statusRef.current = status;

  const facingRef = useRef<CameraDirection>("back");
  facingRef.current = facing;
  // The shared camera session fences every start behind the previous release
  // and drops answers that arrive after the view unmounted.
  const session: CameraSession = useMemo(
    () =>
      createCameraSession({
        camera: Camera,
        active: () => !disposedRef.current && !!previewRef.current,
        preview: () => ({
          element: previewRef.current ?? undefined,
          direction: facingRef.current,
          mirror: false,
        }),
        recording: () => ({}),
      }),
    [],
  );

  const applyStart = useCallback((outcome: CameraStartOutcome) => {
    switch (outcome.status) {
      case "ready":
        setStatus("live");
        return;
      case "denied":
        setStatus("denied");
        return;
      case "unavailable":
        setError(
          outcome.error === undefined
            ? UNAVAILABLE
            : errorMessage(outcome.error),
        );
        setStatus("error");
        return;
      default:
        return;
    }
  }, []);

  /** Asks for camera access, then starts the preview through the session. */
  const startPreview = useCallback(
    async (retry: boolean) => {
      try {
        const perm = await Camera.requestPermissions();
        if (disposedRef.current) return;
        if (perm.camera === "denied") {
          setStatus("denied");
          return;
        }
      } catch (err) {
        if (disposedRef.current) return;
        if (isPermissionDeniedError(err)) {
          setStatus("denied");
          return;
        }
        setError(errorMessage(err));
        setStatus("error");
        return;
      }
      applyStart(await session.start(retry));
    },
    [applyStart, session],
  );

  // Start the preview once on mount; release the camera on unmount. Front/back
  // switching is handled in place by `switchCamera`, so it does not restart this.
  useEffect(() => {
    // Reset for a remount (React StrictMode runs effects twice in development).
    disposedRef.current = false;
    if (!previewRef.current) return;
    void startPreview(false);
    return () => {
      disposedRef.current = true;
      // The session releases the preview after any start in flight; a failed
      // stop has no further recourse and the next start resets native state.
      void session.stop();
    };
  }, [session, startPreview]);

  const retryStart = useCallback(async () => {
    if (!previewRef.current) return;
    setError(null);
    setStatus("starting");
    await startPreview(true);
  }, [startPreview]);

  // A preview stopped on a denial restarts on return only after access was
  // granted in system settings; the host's read never prompts.
  const checkAccess = ports?.checkAccess;
  useEffect(() => {
    if (!checkAccess) return;
    const resumed = () => {
      if (document.visibilityState !== "visible") return;
      void restartAfterResume(
        () => ({
          denied: statusRef.current === "denied" ? "camera" : undefined,
          phase: statusRef.current === "denied" ? "error" : statusRef.current,
          disposed: disposedRef.current,
        }),
        checkAccess,
      ).then((restart) => {
        if (restart) void retryStart();
      });
    };
    document.addEventListener("visibilitychange", resumed);
    return () => document.removeEventListener("visibilitychange", resumed);
  }, [checkAccess, retryStart]);

  const handleSwitch = useCallback(async () => {
    if (busy || status !== "live") return;
    const next: CameraDirection = facing === "back" ? "front" : "back";
    setBusy(true);
    setError(null);
    let failure: unknown;
    try {
      const outcome = await session.control(async () => {
        try {
          await Camera.switchCamera({ direction: next });
        } catch (err) {
          failure = err;
          throw err;
        }
      });
      if (outcome === "done") setFacing(next);
      else if (outcome === "failed") setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [busy, facing, session, status]);

  const handleCapture = useCallback(async () => {
    if (busy || status !== "live") return;
    setBusy(true);
    setError(null);
    try {
      const result = await session.exclusive(() =>
        Camera.capturePhoto({ format: "jpeg", quality: 90 }),
      );
      if (result.status !== "done" || disposedRef.current) return;
      setPhoto(result.value);
      setOperationId(captureOperationId());
      setKept(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [busy, session, status]);

  const handleRetake = useCallback(() => {
    setPhoto(null);
    setOperationId(null);
    setKept(null);
  }, []);

  const keep = ports?.keep;
  const handleKeep = useCallback(async () => {
    if (!keep || !photo || !operationId || handing || kept?.status === "saved")
      return;
    setHanding(true);
    try {
      const outcome = await keepCapture(keep, photo, operationId);
      setKept(outcome);
      // A definite failure kept nothing, and a store keeps that receipt for its identity, so the
      // next Keep uses a fresh one. An unknown outcome keeps this identity, so a retry resolves
      // the same save instead of keeping a duplicate.
      if (outcome.status === "failed") setOperationId(captureOperationId());
    } finally {
      setHanding(false);
    }
  }, [handing, keep, kept, operationId, photo]);

  const handleAction = useCallback(
    async (run: (photo: PhotoResult) => Promise<void> | void) => {
      if (!photo || handing) return;
      setHanding(true);
      setError(null);
      try {
        await run(photo);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setHanding(false);
      }
    },
    [handing, photo],
  );

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
          <Loader2 className="size-7 animate-spin" aria-hidden />
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
            settingsErrorLabel={t("camera.settingsOpenFailed", {
              defaultValue:
                "Couldn’t open Settings. Open System Settings manually, then re-check.",
            })}
            openingLabel={t("camera.openingSettings", {
              defaultValue: "Opening…",
            })}
            checkingLabel={t("camera.checkingPermission", {
              defaultValue: "Checking…",
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
            <AlertTriangle className="size-8 text-white/70" aria-hidden />
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
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
            {kept ? (
              <p
                data-testid="camera-keep-status"
                role="status"
                className="rounded-full bg-black/70 px-3 py-1.5 text-center text-xs text-white"
              >
                {kept.status === "saved"
                  ? (kept.message ??
                    t("camera.kept", { defaultValue: "Photo kept." }))
                  : kept.message}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                variant="secondary"
                onClick={handleRetake}
                disabled={handing}
                data-testid="camera-retake"
              >
                <RotateCcw className="size-4" aria-hidden />
                {t("camera.retake", { defaultValue: "Retake" })}
              </Button>
              {keep ? (
                <Button
                  onClick={handleKeep}
                  disabled={handing || kept?.status === "saved"}
                  data-testid="camera-keep"
                >
                  {keep.label}
                </Button>
              ) : null}
              {ports?.actions?.map((action) => (
                <Button
                  key={action.id}
                  variant="secondary"
                  onClick={() => void handleAction(action.run)}
                  disabled={handing}
                  data-testid={`camera-action-${action.id}`}
                >
                  {action.label}
                </Button>
              ))}
            </div>
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
              variant="surface"
              size="icon-lg"
              shape="circle"
            >
              <SwitchCamera className="size-5" aria-hidden />
            </Button>
          </div>

          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center p-[calc(env(safe-area-inset-bottom,0px)+1.75rem)]">
            <Button
              data-testid="camera-capture"
              aria-label={t("camera.capture", { defaultValue: "Take photo" })}
              onClick={handleCapture}
              disabled={busy}
              variant="surface"
              size="icon-lg"
              shape="circle"
            >
              {busy ? (
                <Loader2
                  className="size-6 animate-spin text-white"
                  aria-hidden
                />
              ) : (
                <span className="size-14 rounded-full bg-white" />
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
          className="absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+1rem)] mx-auto w-fit max-w-[90%] rounded-full bg-danger/90 px-3 py-1.5 text-center text-xs text-danger-foreground"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
