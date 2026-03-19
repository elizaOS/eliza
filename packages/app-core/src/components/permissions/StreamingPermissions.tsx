import { Button } from "@elizaos/ui";
import { Check, Cloud } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../../state";
import { StatusBadge } from "../ui-badges";
import { PermissionIcon } from "./PermissionIcon";

type MediaPermissionState = "granted" | "denied" | "prompt" | "unknown";
type StreamingPermissionMode = "mobile" | "web";

interface MediaPermissionDef {
  id: string;
  name: string;
  description: string;
  icon: string;
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
    description: "Stream video to your agent for vision tasks",
    icon: "camera",
  },
  {
    id: "microphone",
    name: "Microphone",
    description: "Stream audio for voice interaction with your agent",
    icon: "mic",
  },
];

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

function useStreamingPermissions(mode: StreamingPermissionMode) {
  const [permStates, setPermStates] = useState<
    Record<string, MediaPermissionState>
  >({});
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
    async (id: string) => {
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
        }
        return;
      }

      try {
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
        }
      } catch (err) {
        console.error(`Failed to request browser ${id} permission:`, err);
        setPermStates((prev) => ({ ...prev, [id]: "denied" }));
      }
    },
    [mode],
  );

  return { checking, permStates, requestPermission };
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

function useAllPermissionsGranted(
  permStates: Record<string, MediaPermissionState>,
): boolean {
  return useMemo(
    () => MEDIA_PERMISSIONS.every((def) => permStates[def.id] === "granted"),
    [permStates],
  );
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
  const { checking, permStates, requestPermission } =
    useStreamingPermissions(mode);

  if (checking) {
    return (
      <div className="text-center py-6 text-[var(--muted)] text-xs">
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
          <Cloud className="w-4 h-4 text-[var(--accent)]" />
          <div className="font-bold text-sm">{title}</div>
        </div>
        <div className="text-[11px] text-[var(--muted)] mb-3">
          {description}
        </div>
        <div className="border border-[var(--border)] bg-[var(--card)]">
          {MEDIA_PERMISSIONS.map((def) => {
            const status = permStates[def.id] ?? "unknown";
            const isGranted = status === "granted";

            return (
              <div
                key={def.id}
                data-permission-id={def.id}
                className="flex items-center gap-3 py-2.5 px-3 border-b border-[var(--border)] last:border-b-0"
              >
                <PermissionIcon icon={def.icon} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px]">
                      {def.name}
                    </span>
                    <StatusBadge
                      label={getBadgeLabel(status)}
                      tone={getBadgeTone(status)}
                      withDot
                      className="rounded-full font-semibold"
                    />
                  </div>
                  <div className="text-[11px] text-[var(--muted)] mt-0.5 truncate">
                    {def.description}
                  </div>
                </div>
                {!isGranted ? (
                  <Button
                    variant="default"
                    size="sm"
                    className="h-auto text-[11px] py-1 px-2.5"
                    onClick={() => void requestPermission(def.id)}
                    aria-label={`${translateWithFallback(t, "permissionssection.Grant", "Grant")} ${def.name}`}
                  >
                    {translateWithFallback(
                      t,
                      "permissionssection.Grant",
                      "Grant",
                    )}
                  </Button>
                ) : (
                  <Check className="w-4 h-4 text-[var(--ok)]" />
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
  testId: string;
  title: string;
}

export function StreamingPermissionsOnboardingView({
  description,
  mode,
  onContinue,
  testId,
  title,
}: StreamingPermissionsOnboardingViewProps) {
  const { t } = useApp();
  const { checking, permStates, requestPermission } =
    useStreamingPermissions(mode);
  const allGranted = useAllPermissionsGranted(permStates);

  if (checking) {
    return (
      <div className="text-center py-8">
        <div className="text-[var(--muted)] text-sm">
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
      <div className="text-center mb-6">
        <div className="text-xl font-bold mb-2">{title}</div>
        <div className="text-[var(--muted)] text-sm">{description}</div>
      </div>

      <div className="space-y-3 mb-6">
        {MEDIA_PERMISSIONS.map((def) => {
          const isGranted = permStates[def.id] === "granted";

          return (
            <div
              key={def.id}
              data-permission-id={def.id}
              className={`flex items-center gap-4 p-4 border ${
                isGranted
                  ? "border-[var(--ok)] bg-[var(--ok)]/10"
                  : "border-[var(--border)] bg-[var(--card)]"
              }`}
            >
              <PermissionIcon icon={def.icon} />
              <div className="flex-1">
                <div className="font-semibold text-sm">{def.name}</div>
                <div className="text-[11px] text-[var(--muted)]">
                  {def.description}
                </div>
              </div>
              {isGranted ? (
                <Check className="w-4 h-4 text-[var(--ok)]" />
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  className="h-auto text-xs py-1.5 px-3"
                  onClick={() => void requestPermission(def.id)}
                  aria-label={`${translateWithFallback(t, "permissionssection.Grant", "Grant")} ${def.name}`}
                >
                  {translateWithFallback(
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

      <div className="flex flex-wrap justify-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-w-[8.5rem] px-4 py-2 text-[11px] leading-tight opacity-70"
          onClick={() => onContinue({ allowPermissionBypass: true })}
        >
          {translateWithFallback(
            t,
            "permissionssection.SkipForNow",
            "Skip for Now",
          )}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="h-auto min-w-[8.5rem] bg-accent border-accent px-4 py-2 text-[11px] leading-tight text-accent-foreground"
          onClick={() => onContinue()}
        >
          {translateWithFallback(
            t,
            "permissionssection.Continue",
            "Continue",
          )}
        </Button>
      </div>
    </div>
  );
}
