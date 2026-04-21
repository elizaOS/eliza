import {
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectValue,
  SettingsControls,
} from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaConfig } from "../../api";
import {
  getPlugins,
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "../../bridge";
import { useApp } from "../../state";
import type { MediaCategory } from "./media-settings-types";
import { getNestedValue } from "./media-settings-types";

type CameraPluginLike = {
  getDevices?: () => Promise<{
    devices: Array<{ deviceId: string; label: string }>;
  }>;
  checkPermissions?: () => Promise<{
    camera?: "granted" | "denied" | "prompt";
  }>;
  requestPermissions?: () => Promise<{
    camera?: "granted" | "denied" | "prompt";
  }>;
  startPreview?: (options: {
    element: HTMLElement;
    deviceId?: string;
  }) => Promise<unknown>;
  stopPreview?: () => Promise<void>;
  switchCamera?: (options: { deviceId?: string }) => Promise<unknown>;
  capturePhoto?: () => Promise<{ base64?: string }>;
  startRecording?: () => Promise<void>;
  stopRecording?: () => Promise<{ path?: string }>;
  getRecordingState?: () => Promise<{
    isRecording?: boolean;
    duration?: number;
  }>;
};

// ── Desktop Native Capture Controls ───────────────────────────────────

export function DesktopMediaControlPanel() {
  const { t } = useApp();
  const desktopRuntime = isElectrobunRuntime();
  const cameraPlugin = desktopRuntime
    ? (getPlugins().camera.plugin as CameraPluginLike)
    : null;
  const [loading, setLoading] = useState(desktopRuntime);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [cameraDevices, setCameraDevices] = useState<
    Array<{ deviceId: string; label: string }>
  >([]);
  const [cameraPermission, setCameraPermission] = useState("unknown");
  const [cameraPreviewRunning, setCameraPreviewRunning] = useState(false);
  const [cameraRecording, setCameraRecording] = useState(false);
  const [cameraRecordingDuration, setCameraRecordingDuration] = useState(0);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [screenSources, setScreenSources] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [screenPermission, setScreenPermission] = useState("unknown");
  const [screenRecording, setScreenRecording] = useState(false);
  const [screenPaused, setScreenPaused] = useState(false);
  const [screenRecordingDuration, setScreenRecordingDuration] = useState(0);
  const [lastSavedPath, setLastSavedPath] = useState<string | null>(null);
  const [lastPhotoStatus, setLastPhotoStatus] = useState(
    t("mediasettingssection.NoPhotoCapturedYet", {
      defaultValue: "No photo captured yet.",
    }),
  );
  const cameraPreviewHostRef = useRef<HTMLDivElement | null>(null);

  const formatPermissionStatus = useCallback(
    (status: string) =>
      t(`mediasettingssection.PermissionStatus.${status}`, {
        defaultValue: status,
      }),
    [t],
  );

  const refresh = useCallback(async () => {
    if (!desktopRuntime) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const [
      devicesResult,
      cameraPermissionResult,
      cameraRecordingState,
      sourcesResult,
      screenPermissionResult,
      screenRecordingState,
    ] = await Promise.all([
      cameraPlugin?.getDevices?.(),
      cameraPlugin?.checkPermissions?.(),
      cameraPlugin?.getRecordingState?.(),
      invokeDesktopBridgeRequest<{
        sources: Array<{ id: string; name: string }>;
        available: boolean;
      }>({
        rpcMethod: "screencaptureGetSources",
        ipcChannel: "screencapture:getSources",
      }),
      invokeDesktopBridgeRequest<{ status: string }>({
        rpcMethod: "permissionsCheck",
        ipcChannel: "permissions:check",
        params: { id: "screen-recording" },
      }),
      invokeDesktopBridgeRequest<{
        recording: boolean;
        duration: number;
        paused: boolean;
      }>({
        rpcMethod: "screencaptureGetRecordingState",
        ipcChannel: "screencapture:getRecordingState",
      }),
    ]);

    const nextDevices = devicesResult?.devices ?? [];
    const nextSources = sourcesResult?.sources ?? [];

    setCameraDevices(nextDevices);
    setSelectedCameraId((current) => current || nextDevices[0]?.deviceId || "");
    setCameraPermission(cameraPermissionResult?.camera ?? "unknown");
    setCameraRecording(cameraRecordingState?.isRecording ?? false);
    setCameraRecordingDuration(cameraRecordingState?.duration ?? 0);
    setScreenSources(nextSources);
    setSelectedSourceId((current) => current || nextSources[0]?.id || "");
    setScreenPermission(screenPermissionResult?.status ?? "unknown");
    setScreenRecording(screenRecordingState?.recording ?? false);
    setScreenPaused(screenRecordingState?.paused ?? false);
    setScreenRecordingDuration(screenRecordingState?.duration ?? 0);
    setLoading(false);
  }, [cameraPlugin, desktopRuntime]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      void cameraPlugin?.stopPreview?.().catch(() => {});
    },
    [cameraPlugin],
  );

  const runAction = useCallback(
    async (
      id: string,
      action: () => Promise<void>,
      successMessage?: string,
      refreshAfter = true,
    ) => {
      setBusyAction(id);
      setError(null);
      setMessage(null);
      try {
        await action();
        if (refreshAfter) {
          await refresh();
        }
        if (successMessage) {
          setMessage(successMessage);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("mediasettingssection.NativeMediaActionFailed", {
                defaultValue: "Native media action failed.",
              }),
        );
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, t],
  );

  if (!desktopRuntime) {
    return (
      <div className="rounded-xl border border-border bg-bg-muted px-3 py-3 text-xs text-muted">
        {t("mediasettingssection.DesktopOnly", {
          defaultValue:
            "Native camera and screen capture controls are only available inside the Electrobun runtime.",
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-muted px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold text-txt">
            {t("mediasettingssection.NativeCaptureControls", {
              defaultValue: "Native Capture Controls",
            })}
          </div>
          <div className="text-2xs text-muted">
            {t("mediasettingssection.NativeCaptureControlsDesc", {
              defaultValue:
                "Camera preview, capture, recording, and screencapture tools owned by the desktop runtime.",
            })}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void runAction(
              "media-refresh-native",
              async () => {},
              t("mediasettingssection.NativeMediaStateRefreshed", {
                defaultValue: "Native media state refreshed.",
              }),
            )
          }
          disabled={loading || busyAction === "media-refresh-native"}
        >
          {t("common.refresh")}
        </Button>
      </div>

      {(error || message) && (
        <div
          className={`rounded-lg border px-2.5 py-2 text-xs-tight ${
            error
              ? "border-danger/40 bg-danger/10 text-danger"
              : "border-ok/40 bg-ok/10 text-ok"
          }`}
        >
          {error ?? message}
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-border bg-card px-3 py-3">
          <div className="text-xs font-semibold text-txt">
            {t("mediasettingssection.Camera", { defaultValue: "Camera" })}
          </div>
          <div className="text-2xs text-muted">
            {t("mediasettingssection.Permission", {
              defaultValue: "Permission",
            })}
            : {formatPermissionStatus(cameraPermission)} ·{" "}
            {t("mediasettingssection.Recording", {
              defaultValue: "Recording",
            })}
            : {cameraRecording ? t("common.on") : t("common.off")} ·{" "}
            {t("mediasettingssection.Duration", {
              defaultValue: "Duration",
            })}
            : {cameraRecordingDuration}s
          </div>
          <Select
            value={selectedCameraId}
            onValueChange={(value: string) => setSelectedCameraId(value)}
          >
            <SettingsControls.SelectTrigger variant="soft">
              <SelectValue
                placeholder={t("mediasettingssection.NoCameraDevices", {
                  defaultValue: "No camera devices",
                })}
              />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              {cameraDevices.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  {t("mediasettingssection.NoCameraDevices", {
                    defaultValue: "No camera devices",
                  })}
                </SelectItem>
              ) : (
                cameraDevices
                  .filter((device) => device.deviceId)
                  .map((device) => (
                    <SelectItem key={device.deviceId} value={device.deviceId}>
                      {device.label || device.deviceId}
                    </SelectItem>
                  ))
              )}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-camera-permission",
                  async () => {
                    await cameraPlugin?.requestPermissions?.();
                  },
                  t("mediasettingssection.CameraPermissionRequestSent", {
                    defaultValue: "Camera permission request sent.",
                  }),
                )
              }
              disabled={busyAction === "media-camera-permission"}
            >
              {t("mediasettingssection.RequestCameraPermission", {
                defaultValue: "Request Camera Permission",
              })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-camera-preview",
                  async () => {
                    if (cameraPreviewRunning) {
                      await cameraPlugin?.stopPreview?.();
                      setCameraPreviewRunning(false);
                      return;
                    }
                    if (!cameraPreviewHostRef.current) {
                      throw new Error(
                        t("mediasettingssection.CameraPreviewUnavailable", {
                          defaultValue: "Camera preview unavailable.",
                        }),
                      );
                    }
                    await cameraPlugin?.startPreview?.({
                      element: cameraPreviewHostRef.current,
                      deviceId: selectedCameraId || undefined,
                    });
                    setCameraPreviewRunning(true);
                  },
                  cameraPreviewRunning
                    ? t("mediasettingssection.CameraPreviewStopped", {
                        defaultValue: "Camera preview stopped.",
                      })
                    : t("mediasettingssection.CameraPreviewStarted", {
                        defaultValue: "Camera preview started.",
                      }),
                  false,
                )
              }
              disabled={busyAction === "media-camera-preview"}
            >
              {cameraPreviewRunning
                ? t("mediasettingssection.StopPreview", {
                    defaultValue: "Stop Preview",
                  })
                : t("mediasettingssection.StartPreview", {
                    defaultValue: "Start Preview",
                  })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-camera-switch",
                  async () => {
                    if (!selectedCameraId) {
                      throw new Error(
                        t("mediasettingssection.SelectCameraFirst", {
                          defaultValue: "Select a camera device first.",
                        }),
                      );
                    }
                    await cameraPlugin?.switchCamera?.({
                      deviceId: selectedCameraId,
                    });
                  },
                  t("mediasettingssection.CameraSwitched", {
                    defaultValue: "Camera switched.",
                  }),
                )
              }
              disabled={
                !selectedCameraId || busyAction === "media-camera-switch"
              }
            >
              {t("mediasettingssection.SwitchCamera", {
                defaultValue: "Switch Camera",
              })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-camera-capture",
                  async () => {
                    const result = await cameraPlugin?.capturePhoto?.();
                    setLastPhotoStatus(
                      result?.base64
                        ? t("mediasettingssection.PhotoCapturedInMemory", {
                            defaultValue: "Photo captured in memory.",
                          })
                        : t("mediasettingssection.PhotoCaptureCompleted", {
                            defaultValue: "Photo capture completed.",
                          }),
                    );
                  },
                  t("mediasettingssection.PhotoCaptureRequested", {
                    defaultValue: "Photo capture requested.",
                  }),
                  false,
                )
              }
              disabled={busyAction === "media-camera-capture"}
            >
              {t("mediasettingssection.CapturePhoto", {
                defaultValue: "Capture Photo",
              })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-camera-recording",
                  async () => {
                    if (cameraRecording) {
                      const result = await cameraPlugin?.stopRecording?.();
                      setLastSavedPath(result?.path ?? null);
                      return;
                    }

                    await cameraPlugin?.startRecording?.();
                  },
                  cameraRecording
                    ? t("mediasettingssection.CameraRecordingStopped", {
                        defaultValue: "Camera recording stopped.",
                      })
                    : t("mediasettingssection.CameraRecordingStarted", {
                        defaultValue: "Camera recording started.",
                      }),
                )
              }
              disabled={busyAction === "media-camera-recording"}
            >
              {cameraRecording
                ? t("mediasettingssection.StopCameraRecording", {
                    defaultValue: "Stop Camera Recording",
                  })
                : t("mediasettingssection.StartCameraRecording", {
                    defaultValue: "Start Camera Recording",
                  })}
            </Button>
          </div>
          <div
            ref={cameraPreviewHostRef}
            className="min-h-40 overflow-hidden rounded-lg border border-border/60 bg-black/60"
          />
          <div className="text-xs-tight text-muted">{lastPhotoStatus}</div>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card px-3 py-3">
          <div className="text-xs font-semibold text-txt">
            {t("mediasettingssection.ScreenCapture", {
              defaultValue: "Screen Capture",
            })}
          </div>
          <div className="text-2xs text-muted">
            {t("mediasettingssection.Permission", {
              defaultValue: "Permission",
            })}
            : {formatPermissionStatus(screenPermission)} ·{" "}
            {t("mediasettingssection.Recording", {
              defaultValue: "Recording",
            })}
            : {screenRecording ? t("common.on") : t("common.off")} ·{" "}
            {t("mediasettingssection.Duration", {
              defaultValue: "Duration",
            })}
            : {screenRecordingDuration}s
            {screenPaused
              ? ` · ${t("mediasettingssection.Paused", {
                  defaultValue: "paused",
                })}`
              : ""}
          </div>
          <Select
            value={selectedSourceId}
            onValueChange={(value: string) => setSelectedSourceId(value)}
          >
            <SettingsControls.SelectTrigger variant="soft">
              <SelectValue
                placeholder={t("mediasettingssection.NoScreenSources", {
                  defaultValue: "No screen sources",
                })}
              />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              {screenSources.length === 0 ? (
                <SelectItem value="__none__" disabled>
                  {t("mediasettingssection.NoScreenSources", {
                    defaultValue: "No screen sources",
                  })}
                </SelectItem>
              ) : (
                screenSources
                  .filter((source) => source.id)
                  .map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.name}
                    </SelectItem>
                  ))
              )}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-screen-open-settings",
                  async () => {
                    await invokeDesktopBridgeRequest<void>({
                      rpcMethod: "permissionsOpenSettings",
                      ipcChannel: "permissions:openSettings",
                      params: { id: "screen-recording" },
                    });
                  },
                  t("mediasettingssection.OpenedScreenRecordingSettings", {
                    defaultValue: "Opened screen recording settings.",
                  }),
                  false,
                )
              }
              disabled={busyAction === "media-screen-open-settings"}
            >
              {t("mediasettingssection.OpenScreenPermissionSettings", {
                defaultValue: "Open Screen Permission Settings",
              })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-screen-switch-source",
                  async () => {
                    if (!selectedSourceId) {
                      throw new Error(
                        t("mediasettingssection.SelectScreenSourceFirst", {
                          defaultValue: "Select a screen source first.",
                        }),
                      );
                    }
                    await invokeDesktopBridgeRequest<{ available: boolean }>({
                      rpcMethod: "screencaptureSwitchSource",
                      ipcChannel: "screencapture:switchSource",
                      params: { sourceId: selectedSourceId },
                    });
                  },
                  t("mediasettingssection.ScreenSourceSwitched", {
                    defaultValue: "Screen source switched.",
                  }),
                )
              }
              disabled={
                !selectedSourceId || busyAction === "media-screen-switch-source"
              }
            >
              {t("mediasettingssection.SwitchSource", {
                defaultValue: "Switch Source",
              })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-screen-screenshot",
                  async () => {
                    const screenshot = await invokeDesktopBridgeRequest<{
                      available: boolean;
                      data?: string;
                    }>({
                      rpcMethod: "screencaptureTakeScreenshot",
                      ipcChannel: "screencapture:takeScreenshot",
                    });
                    if (screenshot?.available === false || !screenshot?.data) {
                      throw new Error(
                        t("mediasettingssection.ScreenshotUnavailable", {
                          defaultValue: "Screenshot unavailable.",
                        }),
                      );
                    }
                    const saved = await invokeDesktopBridgeRequest<{
                      available: boolean;
                      path?: string;
                    }>({
                      rpcMethod: "screencaptureSaveScreenshot",
                      ipcChannel: "screencapture:saveScreenshot",
                      params: {
                        data: screenshot.data,
                        filename: "elizaos-desktop-screenshot.png",
                      },
                    });
                    setLastSavedPath(saved?.path ?? null);
                  },
                  t("mediasettingssection.ScreenshotCapturedAndSaved", {
                    defaultValue: "Screenshot captured and saved.",
                  }),
                  false,
                )
              }
              disabled={busyAction === "media-screen-screenshot"}
            >
              {t("mediasettingssection.TakeScreenshot", {
                defaultValue: "Take Screenshot",
              })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runAction(
                  "media-screen-recording",
                  async () => {
                    if (screenRecording) {
                      const stopped = await invokeDesktopBridgeRequest<{
                        available: boolean;
                        path?: string;
                      }>({
                        rpcMethod: "screencaptureStopRecording",
                        ipcChannel: "screencapture:stopRecording",
                      });
                      setLastSavedPath(stopped?.path ?? null);
                      return;
                    }

                    const started = await invokeDesktopBridgeRequest<{
                      available: boolean;
                      reason?: string;
                    }>({
                      rpcMethod: "screencaptureStartRecording",
                      ipcChannel: "screencapture:startRecording",
                    });
                    if (started?.available === false) {
                      throw new Error(
                        t("mediasettingssection.ScreenRecordingUnavailable", {
                          defaultValue: "Screen recording unavailable.",
                        }),
                      );
                    }
                  },
                  screenRecording
                    ? t("mediasettingssection.ScreenRecordingStopped", {
                        defaultValue: "Screen recording stopped.",
                      })
                    : t("mediasettingssection.ScreenRecordingStarted", {
                        defaultValue: "Screen recording started.",
                      }),
                )
              }
              disabled={busyAction === "media-screen-recording"}
            >
              {screenRecording
                ? t("mediasettingssection.StopScreenRecording", {
                    defaultValue: "Stop Screen Recording",
                  })
                : t("mediasettingssection.StartScreenRecording", {
                    defaultValue: "Start Screen Recording",
                  })}
            </Button>
            {screenRecording && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void runAction(
                    "media-screen-pause-toggle",
                    async () => {
                      await invokeDesktopBridgeRequest<{ available: boolean }>({
                        rpcMethod: screenPaused
                          ? "screencaptureResumeRecording"
                          : "screencapturePauseRecording",
                        ipcChannel: screenPaused
                          ? "screencapture:resumeRecording"
                          : "screencapture:pauseRecording",
                      });
                    },
                    screenPaused
                      ? t("mediasettingssection.ScreenRecordingResumed", {
                          defaultValue: "Screen recording resumed.",
                        })
                      : t("mediasettingssection.ScreenRecordingPaused", {
                          defaultValue: "Screen recording paused.",
                        }),
                  )
                }
                disabled={busyAction === "media-screen-pause-toggle"}
              >
                {screenPaused
                  ? t("mediasettingssection.ResumeRecording", {
                      defaultValue: "Resume Recording",
                    })
                  : t("mediasettingssection.PauseRecording", {
                      defaultValue: "Pause Recording",
                    })}
              </Button>
            )}
            {lastSavedPath && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void runAction(
                    "media-open-saved-path",
                    async () => {
                      await invokeDesktopBridgeRequest<void>({
                        rpcMethod: "desktopOpenPath",
                        ipcChannel: "desktop:openPath",
                        params: { path: lastSavedPath },
                      });
                    },
                    t("mediasettingssection.OpenedSavedCapture", {
                      defaultValue: "Opened saved capture.",
                    }),
                    false,
                  )
                }
                disabled={busyAction === "media-open-saved-path"}
              >
                {t("mediasettingssection.OpenSavedCapture", {
                  defaultValue: "Open Saved Capture",
                })}
              </Button>
            )}
          </div>
          <div className="text-xs-tight text-muted break-all">
            {lastSavedPath
              ? t("mediasettingssection.LastSavedPath", {
                  defaultValue: "Last saved path: {{path}}",
                  path: lastSavedPath,
                })
              : t("mediasettingssection.NoSavedCapturePathYet", {
                  defaultValue: "No saved capture path yet.",
                })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Provider-specific model selection panels ──────────────────────────

interface ProviderModelPanelProps {
  activeTab: MediaCategory;
  currentProvider: string;
  mediaConfig: MediaConfig;
  updateNestedValue: (path: string, value: unknown) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function ProviderModelSelectors({
  activeTab,
  currentProvider,
  mediaConfig,
  updateNestedValue,
  t,
}: ProviderModelPanelProps) {
  return (
    <>
      {/* Provider-specific model selection for image generation */}
      {activeTab === "image" && currentProvider === "fal" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.Model")}
          </span>
          <Select
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "image.fal.model",
              ) as string) ?? "fal-ai/flux-pro"
            }
            onValueChange={(value: string) =>
              updateNestedValue("image.fal.model", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t("mediasettingssection.Flux")}</SelectLabel>
                <SelectItem value="fal-ai/flux-pro">
                  {t("mediasettingssection.FluxPro")}
                </SelectItem>
                <SelectItem value="fal-ai/flux-pro/v1.1">
                  {t("mediasettingssection.FluxProV11")}
                </SelectItem>
                <SelectItem value="fal-ai/flux-pro/kontext">
                  {t("mediasettingssection.FluxKontextPro")}
                </SelectItem>
                <SelectItem value="fal-ai/flux-2-flex">
                  {t("mediasettingssection.Flux2Flex")}
                </SelectItem>
                <SelectItem value="fal-ai/flux/dev">
                  {t("mediasettingssection.FluxDev")}
                </SelectItem>
                <SelectItem value="fal-ai/flux/schnell">
                  {t("mediasettingssection.FluxSchnell")}
                </SelectItem>
                <SelectItem value="fal-ai/fast-flux">
                  {t("mediasettingssection.FastFlux")}
                </SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>
                  {t("mediasettingssection.OtherModels")}
                </SelectLabel>
                <SelectItem value="fal-ai/nano-banana-pro">
                  {t("mediasettingssection.NanoBananaProGoo")}
                </SelectItem>
                <SelectItem value="fal-ai/recraft/v3/text-to-image">
                  {t("mediasettingssection.RecraftV3")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-image/v3/text-to-image">
                  {t("mediasettingssection.KlingImageV3")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-image/o3/text-to-image">
                  {t("mediasettingssection.KlingImageO3")}
                </SelectItem>
                <SelectItem value="xai/grok-imagine-image">
                  {t("mediasettingssection.GrokImagineXAI")}
                </SelectItem>
                <SelectItem value="fal-ai/stable-diffusion-3">
                  {t("mediasettingssection.StableDiffusion3")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      )}

      {activeTab === "image" && currentProvider === "openai" && (
        <div className="flex gap-3">
          <div className="flex-1 flex flex-col gap-1.5">
            <span className="text-xs font-semibold">
              {t("mediasettingssection.Model")}
            </span>
            <Select
              value={
                (getNestedValue(
                  mediaConfig as Record<string, unknown>,
                  "image.openai.model",
                ) as string) ?? "dall-e-3"
              }
              onValueChange={(value: string) =>
                updateNestedValue("image.openai.model", value)
              }
            >
              <SettingsControls.SelectTrigger variant="compact">
                <SelectValue />
              </SettingsControls.SelectTrigger>
              <SelectContent>
                <SelectItem value="dall-e-3">
                  {t("mediasettingssection.DALLE3")}
                </SelectItem>
                <SelectItem value="dall-e-2">
                  {t("mediasettingssection.DALLE2")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 flex flex-col gap-1.5">
            <span className="text-xs font-semibold">
              {t("mediasettingssection.Quality")}
            </span>
            <Select
              value={
                (getNestedValue(
                  mediaConfig as Record<string, unknown>,
                  "image.openai.quality",
                ) as string) ?? "standard"
              }
              onValueChange={(value: string) =>
                updateNestedValue("image.openai.quality", value)
              }
            >
              <SettingsControls.SelectTrigger variant="compact">
                <SelectValue />
              </SettingsControls.SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">
                  {t("mediasettingssection.Standard")}
                </SelectItem>
                <SelectItem value="hd">
                  {t("mediasettingssection.HD", {
                    defaultValue: "HD",
                  })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Video FAL model selection */}
      {activeTab === "video" && currentProvider === "fal" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.Model")}
          </span>
          <Select
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "video.fal.model",
              ) as string) ?? "fal-ai/kling-video/v3/pro/text-to-video"
            }
            onValueChange={(value: string) =>
              updateNestedValue("video.fal.model", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>
                  {t("mediasettingssection.TextToVideo")}
                </SelectLabel>
                <SelectItem value="fal-ai/veo3.1">
                  {t("mediasettingssection.Veo31Google")}
                </SelectItem>
                <SelectItem value="fal-ai/veo3.1/fast">
                  {t("mediasettingssection.Veo31Fast")}
                </SelectItem>
                <SelectItem value="fal-ai/sora-2/text-to-video">
                  {t("mediasettingssection.Sora2")}
                </SelectItem>
                <SelectItem value="fal-ai/sora-2/text-to-video/pro">
                  {t("mediasettingssection.Sora2Pro")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-video/v3/pro/text-to-video">
                  {t("mediasettingssection.Kling30Pro")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-video/v3/standard/text-to-video">
                  {t("mediasettingssection.Kling30")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-video/o3/pro/text-to-video">
                  {t("mediasettingssection.KlingO3Pro")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-video/o3/standard/text-to-video">
                  {t("mediasettingssection.KlingO3")}
                </SelectItem>
                <SelectItem value="xai/grok-imagine-video/text-to-video">
                  {t("mediasettingssection.GrokVideoXAI")}
                </SelectItem>
                <SelectItem value="fal-ai/minimax/video-01-live">
                  {t("mediasettingssection.MinimaxHailuo")}
                </SelectItem>
                <SelectItem value="fal-ai/hunyuan-video">
                  {t("mediasettingssection.HunyuanVideo")}
                </SelectItem>
                <SelectItem value="fal-ai/mochi-v1">
                  {t("mediasettingssection.Mochi1")}
                </SelectItem>
                <SelectItem value="fal-ai/wan/v2.2-a14b/text-to-video">
                  {t("mediasettingssection.Wan22")}
                </SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>
                  {t("mediasettingssection.ImageToVideo")}
                </SelectLabel>
                <SelectItem value="fal-ai/kling-video/v3/pro/image-to-video">
                  {t("mediasettingssection.Kling30Pro")}
                </SelectItem>
                <SelectItem value="fal-ai/kling-video/o3/standard/image-to-video">
                  {t("mediasettingssection.KlingO3")}
                </SelectItem>
                <SelectItem value="fal-ai/veo3.1/image-to-video">
                  {t("mediasettingssection.Veo31")}
                </SelectItem>
                <SelectItem value="fal-ai/veo3.1/fast/image-to-video">
                  {t("mediasettingssection.Veo31Fast")}
                </SelectItem>
                <SelectItem value="fal-ai/sora-2/image-to-video">
                  {t("mediasettingssection.Sora2")}
                </SelectItem>
                <SelectItem value="fal-ai/sora-2/image-to-video/pro">
                  {t("mediasettingssection.Sora2Pro")}
                </SelectItem>
                <SelectItem value="xai/grok-imagine-video/image-to-video">
                  {t("mediasettingssection.GrokXAI")}
                </SelectItem>
                <SelectItem value="fal-ai/minimax/video-01-live/image-to-video">
                  {t("mediasettingssection.MinimaxHailuo")}
                </SelectItem>
                <SelectItem value="fal-ai/luma-dream-machine/image-to-video">
                  {t("mediasettingssection.LumaDreamMachine")}
                </SelectItem>
                <SelectItem value="fal-ai/pixverse/v4.5/image-to-video">
                  {t("mediasettingssection.PixverseV45")}
                </SelectItem>
                <SelectItem value="fal-ai/ltx-2-19b/image-to-video">
                  {t("mediasettingssection.LTX219B")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Audio Suno model selection */}
      {activeTab === "audio" && currentProvider === "suno" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.Model")}
          </span>
          <Select
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "audio.suno.model",
              ) as string) ?? "chirp-v3.5"
            }
            onValueChange={(value: string) =>
              updateNestedValue("audio.suno.model", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="chirp-v3.5">
                {t("mediasettingssection.ChirpV35")}
              </SelectItem>
              <SelectItem value="chirp-v3">
                {t("mediasettingssection.ChirpV3")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Audio ElevenLabs duration */}
      {activeTab === "audio" && currentProvider === "elevenlabs" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.MaxDurationSecond")}
          </span>
          <SettingsControls.Input
            type="number"
            min={0.5}
            max={22}
            step={0.5}
            variant="compact"
            className="w-24"
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "audio.elevenlabs.duration",
              ) as number) ?? 5
            }
            onChange={(e) =>
              updateNestedValue(
                "audio.elevenlabs.duration",
                parseFloat(e.target.value),
              )
            }
          />
        </div>
      )}

      {/* Vision model selection */}
      {activeTab === "vision" && currentProvider === "openai" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.Model")}
          </span>
          <Select
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "vision.openai.model",
              ) as string) ?? "gpt-4o"
            }
            onValueChange={(value: string) =>
              updateNestedValue("vision.openai.model", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="gpt-4o">
                {t("mediasettingssection.GPT4o")}
              </SelectItem>
              <SelectItem value="gpt-4o-mini">
                {t("mediasettingssection.GPT4oMini")}
              </SelectItem>
              <SelectItem value="gpt-4-turbo">
                {t("mediasettingssection.GPT4Turbo")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {activeTab === "vision" && currentProvider === "google" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.Model")}
          </span>
          <Select
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "vision.google.model",
              ) as string) ?? "gemini-2.0-flash"
            }
            onValueChange={(value: string) =>
              updateNestedValue("vision.google.model", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="gemini-2.0-flash">
                {t("mediasettingssection.Gemini20Flash")}
              </SelectItem>
              <SelectItem value="gemini-1.5-pro">
                {t("mediasettingssection.Gemini15Pro")}
              </SelectItem>
              <SelectItem value="gemini-1.5-flash">
                {t("mediasettingssection.Gemini15Flash")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {activeTab === "vision" && currentProvider === "anthropic" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold">
            {t("mediasettingssection.Model")}
          </span>
          <Select
            value={
              (getNestedValue(
                mediaConfig as Record<string, unknown>,
                "vision.anthropic.model",
              ) as string) ?? "claude-sonnet-4-6"
            }
            onValueChange={(value: string) =>
              updateNestedValue("vision.anthropic.model", value)
            }
          >
            <SettingsControls.SelectTrigger variant="compact">
              <SelectValue />
            </SettingsControls.SelectTrigger>
            <SelectContent>
              <SelectItem value="claude-sonnet-4-6">
                {t("mediasettingssection.ClaudeSonnet4")}
              </SelectItem>
              <SelectItem value="claude-haiku-4-5-20251001">
                {t("mediasettingssection.Claude3Haiku")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </>
  );
}
