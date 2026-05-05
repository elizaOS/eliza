import { Button, StatusBadge } from "@elizaos/ui";
import { Check, Cloud, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../state";
import { PermissionIcon } from "./PermissionIcon";

type MediaPermissionState = "granted" | "denied" | "prompt" | "unknown";
export type StreamingPermissionMode = "mobile" | "web";
type MediaPermissionId = "camera" | "microphone" | "screen";

export interface MediaPermissionDef {
  id: MediaPermissionId;
  name: string;
  nameKey: string;
  description: string;
  descriptionKey: string;
  icon: string;
  modes?: readonly StreamingPermissionMode[];
}

interface CameraPermissionPlugin {
  checkPermissions?: () => Promise<{
    camera: string;
    microphone: string;
  }>;
  requestPermissions?: () => Promise<{
    camera: string;
    microphone: string;
  }>;
}

const MEDIA_PERMISSIONS: MediaPermissionDef[] = [
  {
    id: "camera",
    name: "Camera",
    nameKey: "permissionssection.streaming.camera.name",
    description: "Stream video to your agent for vision tasks",
    descriptionKey: "permissionssection.streaming.camera.description",
    icon: "camera",
  },
  {
    id: "microphone",
    name: "Microphone",
    nameKey: "permissionssection.streaming.microphone.name",
    description: "Stream audio for voice interaction with your agent",
    descriptionKey: "permissionssection.streaming.microphone.description",
    icon: "mic",
  },
  {
    id: "screen",
    name: "Screen",
    nameKey: "permissionssection.streaming.screen.name",
    description: "Share your screen with your agent",
    descriptionKey: "permissionssection.streaming.screen.description",
    icon: "monitor",
    modes: ["web"],
  },
];

export function isStreamingPermissionVisibleForMode(
  def: MediaPermissionDef,
  mode: StreamingPermissionMode,
): boolean {
  return !def.modes || def.modes.includes(mode);
}

function translateWithFallback(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const value = t(key);
  return !value || value === key ? fallback : value;
}

function getCameraPermissionPlugin(): CameraPermissionPlugin | null {
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { Plugins?: Record<string, unknown> }
    | undefined;
  if (!cap?.Plugins) return null;
  return (
    (cap.Plugins.ElizaCamera as CameraPermissionPlugin | undefined) ?? null
  );
}

async function checkMobilePermissions(): Promise<
  Record<string, MediaPermissionState>
> {
  const states: Record<string, MediaPermissionState> = {};
  const plugin = getCameraPermissionPlugin();
  if (!plugin?.checkPermissions) return states;

  try {
    const result = await plugin.checkPermissions();
    states.camera = result.camera as MediaPermissionState;
    states.microphone = result.microphone as MediaPermissionState;
  } catch (err) {
    console.error("Failed to check mobile permissions:", err);
  }

  return states;
}

async function checkWebPermissions(): Promise<
  Record<string, MediaPermissionState>
> {
  const states: Record<string, MediaPermissionState> = {};
  states.screen =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
      ? "prompt"
      : "unknown";

  try {
    if (navigator.permissions) {
      const [cameraPermission, microphonePermission] = await Promise.all([
        navigator.permissions.query({ name: "camera" as PermissionName }),
        navigator.permissions.query({
          name: "microphone" as PermissionName,
        }),
      ]);
      states.camera = cameraPermission.state as MediaPermissionState;
      states.microphone = microphonePermission.state as MediaPermissionState;
    }
  } catch {
    // Permissions API may not support camera/mic queries in all browsers.
  }

  return states;
}

function webPermissionErrorMessage(
  id: MediaPermissionId,
  err: unknown,
): string {
  const label =
    id === "camera" ? "Camera" : id === "microphone" ? "Microphone" : "Screen";
  const device = label.toLowerCase();
  const name = err instanceof DOMException ? err.name : "";

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return `${label} is blocked for this site. Allow it in browser site settings, then try again.`;
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return `No ${device} source was found.`;
  }
  if (id === "screen" && name === "NotSupportedError") {
    return "Screen sharing is not available in this browser.";
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message.trim();
  }
  return `Could not request ${device} permission.`;
}

function useStreamingPermissions(mode: StreamingPermissionMode) {
  const [permStates, setPermStates] = useState<
    Record<string, MediaPermissionState>
  >({});
  const [permissionErrors, setPermissionErrors] = useState<
    Partial<Record<MediaPermissionId, string>>
  >({});
  const [requestingId, setRequestingId] = useState<MediaPermissionId | null>(
    null,
  );
  const [checking, setChecking] = useState(true);

  const checkPermissions = useCallback(async () => {
    if (mode === "mobile") {
      return checkMobilePermissions();
    }
    return checkWebPermissions();
  }, [mode]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setChecking(true);
      const nextStates = await checkPermissions();
      if (!cancelled) {
        setPermStates(nextStates);
        setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checkPermissions]);

  const requestPermission = useCallback(
    async (id: MediaPermissionId) => {
      setRequestingId(id);
      setPermissionErrors((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (mode === "mobile") {
        try {
          const plugin = getCameraPermissionPlugin();
          if (!plugin?.requestPermissions) return;
          const result = await plugin.requestPermissions();
          setPermStates((prev) => ({
            ...prev,
            camera: result.camera as MediaPermissionState,
            microphone: result.microphone as MediaPermissionState,
          }));
        } catch (err) {
          console.error("Failed to request mobile permission:", err);
          setPermissionErrors((prev) => ({
            ...prev,
            [id]: "Could not request device permissions.",
          }));
        } finally {
          setRequestingId(null);
        }
        return;
      }

      try {
        if (!navigator.mediaDevices) {
          throw new Error("Media devices are not available in this browser.");
        }
        if (id === "camera") {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          setPermStates((prev) => ({ ...prev, camera: "granted" }));
          return;
        }
        if (id === "microphone") {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          setPermStates((prev) => ({ ...prev, microphone: "granted" }));
          return;
        }
        if (id === "screen") {
          if (typeof navigator.mediaDevices.getDisplayMedia !== "function") {
            throw new DOMException(
              "Screen sharing is not available.",
              "NotSupportedError",
            );
          }
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
          });
          stream.getTracks().forEach((track) => {
            track.stop();
          });
          setPermStates((prev) => ({ ...prev, screen: "granted" }));
        }
      } catch (err) {
        console.error(`Failed to request browser ${id} permission:`, err);
        setPermStates((prev) => ({ ...prev, [id]: "denied" }));
        setPermissionErrors((prev) => ({
          ...prev,
          [id]: webPermissionErrorMessage(id, err),
        }));
      } finally {
        setRequestingId(null);
      }
    },
    [mode],
  );

  return {
    checking,
    permissionErrors,
    permStates,
    requestPermission,
    requestingId,
  };
}

function getBadgeTone(
  state: MediaPermissionState,
): "success" | "danger" | "warning" {
  if (state === "granted") return "success";
  if (state === "denied") return "danger";
  return "warning";
}

function getBadgeLabel(state: MediaPermissionState): string {
  if (state === "granted") return "Granted";
  if (state === "denied") return "Denied";
  return "Not Set";
}

interface StreamingPermissionsSettingsViewProps {
  description: string;
  mode: StreamingPermissionMode;
  testId: string;
  title: string;
}

export function StreamingPermissionsSettingsView({
  description,
  mode,
  testId,
  title,
}: StreamingPermissionsSettingsViewProps) {
  const { t } = useApp();
  const {
    checking,
    permissionErrors,
    permStates,
    requestPermission,
    requestingId,
  } = useStreamingPermissions(mode);

  if (checking) {
    return (
      <div className="text-center py-6 text-muted text-xs">
        {translateWithFallback(
          t,
          "permissionssection.LoadingPermissions",
          "Loading permissions...",
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid={testId}>
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Cloud className="w-4 h-4 text-accent" />
          <div className="font-bold text-sm">{title}</div>
        </div>
        <div className="text-xs-tight text-muted mb-3">{description}</div>
        <div className="border border-border bg-card">
          {MEDIA_PERMISSIONS.filter((def) =>
            isStreamingPermissionVisibleForMode(def, mode),
          ).map((def) => {
            const status = permStates[def.id] ?? "unknown";
            const isGranted = status === "granted";
            const isRequesting = requestingId === def.id;
            const name = translateWithFallback(t, def.nameKey, def.name);
            const error =
              permissionErrors[def.id] ??
              (status === "denied"
                ? `${name} is blocked for this site. Allow it in browser site settings, then try again.`
                : null);
            const description = translateWithFallback(
              t,
              def.descriptionKey,
              def.description,
            );

            return (
              <div
                key={def.id}
                data-permission-id={def.id}
                className="flex items-center gap-3 py-2.5 px-3"
              >
                <PermissionIcon icon={def.icon} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{name}</span>
                    <StatusBadge
                      label={translateWithFallback(
                        t,
                        status === "granted"
                          ? "permissionssection.badge.granted"
                          : status === "denied"
                            ? "permissionssection.badge.denied"
                            : "permissionssection.badge.notDetermined",
                        getBadgeLabel(status),
                      )}
                      variant={getBadgeTone(status)}
                      withDot
                      className="rounded-full font-semibold"
                    />
                  </div>
                  <div className="text-xs-tight text-muted mt-0.5 truncate">
                    {description}
                  </div>
                  {error ? (
                    <div className="mt-1 text-xs-tight text-danger">
                      {error}
                    </div>
                  ) : null}
                </div>
                {!isGranted ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="h-auto text-xs-tight py-1 px-2.5"
                    disabled={isRequesting}
                    onClick={() => void requestPermission(def.id)}
                    aria-label={`${translateWithFallback(t, "permissionssection.Grant", "Grant")} ${name}`}
                  >
                    {isRequesting ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : null}
                    {isRequesting
                      ? translateWithFallback(
                          t,
                          "permissionssection.Requesting",
                          "Requesting",
                        )
                      : translateWithFallback(
                          t,
                          "permissionssection.Grant",
                          "Grant",
                        )}
                  </Button>
                ) : (
                  <Check className="w-4 h-4 text-ok" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface StreamingPermissionsOnboardingViewProps {
  description: string;
  mode: StreamingPermissionMode;
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
  onBack?: () => void;
  testId: string;
  title: string;
}

export function StreamingPermissionsOnboardingView({
  description,
  mode,
  onContinue,
  onBack,
  testId,
  title,
}: StreamingPermissionsOnboardingViewProps) {
  const { t } = useApp();
  const { checking, permStates, requestPermission, requestingId } =
    useStreamingPermissions(mode);

  if (checking) {
    return (
      <div className="text-center py-8">
        <div className="text-sm text-[var(--onboarding-text-primary)]">
          {translateWithFallback(
            t,
            "permissionssection.CheckingPermissions",
            "Checking permissions...",
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid={testId}>
      <div className="mb-5 text-center">
        <div className="mb-2 text-xl font-bold text-[var(--onboarding-text-strong)]">
          {title}
        </div>
        <div className="text-sm text-[var(--onboarding-text-primary)]">
          {description}
        </div>
      </div>

      <div className="mb-6 space-y-2.5">
        {MEDIA_PERMISSIONS.filter((def) =>
          isStreamingPermissionVisibleForMode(def, mode),
        ).map((def) => {
          const isGranted = permStates[def.id] === "granted";
          const isRequesting = requestingId === def.id;
          const name = translateWithFallback(t, def.nameKey, def.name);
          const description = translateWithFallback(
            t,
            def.descriptionKey,
            def.description,
          );

          return (
            <div
              key={def.id}
              data-permission-id={def.id}
              className={`flex items-center gap-4 rounded-[16px] border px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${
                isGranted
                  ? "border-ok bg-[color:color-mix(in_srgb,var(--ok)_16%,var(--onboarding-card-bg)_84%)]"
                  : "border-[var(--onboarding-card-border)] bg-[var(--onboarding-card-bg)]"
              }`}
            >
              <PermissionIcon icon={def.icon} />
              <div className="flex-1">
                <div className="text-sm font-semibold text-[var(--onboarding-text-strong)]">
                  {name}
                </div>
                <div className="text-xs-tight text-[var(--onboarding-text-subtle)]">
                  {description}
                </div>
              </div>
              {isGranted ? (
                <Check className="w-4 h-4 text-ok" />
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  className="h-auto text-xs py-1.5 px-3"
                  disabled={isRequesting}
                  onClick={() => void requestPermission(def.id)}
                  aria-label={`${translateWithFallback(t, "permissionssection.Grant", "Grant")} ${name}`}
                >
                  {isRequesting
                    ? translateWithFallback(
                        t,
                        "permissionssection.Requesting",
                        "Requesting",
                      )
                    : translateWithFallback(
                        t,
                        "permissionssection.Grant",
                        "Grant",
                      )}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between items-center gap-6 mt-[18px] pt-3.5">
        {onBack ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-2xs text-[rgba(240,238,250,0.62)] tracking-[0.15em] uppercase cursor-pointer no-underline transition-colors duration-300 p-0 hover:text-[rgba(240,238,250,0.9)]"
            style={{ textShadow: "0 1px 8px rgba(3,5,10,0.45)" }}
            onClick={() => onBack()}
          >
            {translateWithFallback(t, "onboarding.back", "Back")}
          </Button>
        ) : (
          <span />
        )}
        <Button
          variant="default"
          data-testid="permissions-onboarding-continue"
          className="group relative inline-flex items-center justify-center gap-[8px] px-[32px] py-[12px] min-h-touch bg-[rgba(240,185,11,0.18)] border border-[rgba(240,185,11,0.35)] rounded-sm text-[var(--onboarding-accent-foreground)] text-xs-tight font-semibold tracking-[0.18em] uppercase cursor-pointer transition-all duration-300 overflow-hidden hover:bg-[rgba(240,185,11,0.28)] hover:border-[rgba(240,185,11,0.6)] disabled:opacity-40 disabled:cursor-not-allowed"
          onClick={(e) => {
            if (e?.currentTarget) {
              const rect = e.currentTarget.getBoundingClientRect();
              const circle = document.createElement("span");
              const diameter = Math.max(rect.width, rect.height);
              circle.style.width = circle.style.height = `${diameter}px`;
              circle.style.left = `${e.clientX - rect.left - diameter / 2}px`;
              circle.style.top = `${e.clientY - rect.top - diameter / 2}px`;
              circle.className =
                "absolute rounded-full bg-[rgba(240,185,11,0.3)] transform scale-0 animate-[onboarding-ripple-expand_0.6s_ease-out_forwards] pointer-events-none";
              e.currentTarget.appendChild(circle);
              setTimeout(() => circle.remove(), 600);
            }
            onContinue();
          }}
        >
          {translateWithFallback(t, "onboarding.savedMyKeys", "Continue")}
        </Button>
      </div>
    </div>
  );
}
