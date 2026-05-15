import {
  type AndroidRoleName,
  type AndroidRoleStatus,
  type DeviceSettingsStatus,
  System,
  type SystemStatus,
  type SystemVolumeStatus,
  type SystemVolumeStream,
} from "@elizaos/capacitor-system";
import type { OverlayAppContext } from "@elizaos/ui";
import { Button } from "@elizaos/ui";
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  MonitorCog,
  RefreshCw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Volume2,
  Wifi,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const ROLE_LABELS: Record<AndroidRoleName, string> = {
  home: "Home",
  dialer: "Phone",
  sms: "SMS",
  assistant: "Assistant",
};

const VOLUME_LABELS: Partial<Record<SystemVolumeStream, string>> = {
  music: "Media",
  ring: "Ring",
  alarm: "Alarm",
  notification: "Notifications",
  system: "System",
  voiceCall: "Voice call",
};

function percent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

function streamPercent(volume: SystemVolumeStatus): number {
  if (volume.max <= 0) return 0;
  return Math.round((volume.current / volume.max) * 100);
}

function roleStatusLabel(role: AndroidRoleStatus): string {
  if (!role.available) return "Unavailable";
  if (role.held) return "Assigned";
  if (role.holders.length > 0) return role.holders[0] ?? "Assigned elsewhere";
  return "Not assigned";
}

type SavingKey =
  | "brightness"
  | `volume:${SystemVolumeStream}`
  | `role:${AndroidRoleName}`
  | null;

export function DeviceSettingsAppView({ exitToApps, t }: OverlayAppContext) {
  const [deviceSettings, setDeviceSettings] =
    useState<DeviceSettingsStatus | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [brightness, setBrightness] = useState(0.75);
  const [volumes, setVolumes] = useState<
    Partial<Record<SystemVolumeStream, number>>
  >({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<SavingKey>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResult, statusResult] = await Promise.all([
        System.getDeviceSettings(),
        System.getStatus(),
      ]);
      setDeviceSettings(settingsResult);
      setSystemStatus(statusResult);
      setBrightness(settingsResult.brightness);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!deviceSettings) return;
    setVolumes(
      Object.fromEntries(
        deviceSettings.volumes.map((volume) => [volume.stream, volume.current]),
      ),
    );
  }, [deviceSettings]);

  const roles = useMemo(() => systemStatus?.roles ?? [], [systemStatus]);
  const orderedVolumes = useMemo(
    () =>
      [...(deviceSettings?.volumes ?? [])].sort((a, b) =>
        (VOLUME_LABELS[a.stream] ?? a.stream).localeCompare(
          VOLUME_LABELS[b.stream] ?? b.stream,
        ),
      ),
    [deviceSettings],
  );

  const applyBrightness = useCallback(async () => {
    setSaving("brightness");
    setError(null);
    setNotice(null);
    try {
      const next = await System.setScreenBrightness({ brightness });
      setDeviceSettings(next);
      setNotice("Brightness updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }, [brightness]);

  const applyVolume = useCallback(
    async (volume: SystemVolumeStatus) => {
      const nextValue = volumes[volume.stream] ?? volume.current;
      setSaving(`volume:${volume.stream}`);
      setError(null);
      setNotice(null);
      try {
        const next = await System.setVolume({
          stream: volume.stream,
          volume: nextValue,
        });
        setDeviceSettings((current) => {
          if (!current) return current;
          return {
            ...current,
            volumes: current.volumes.map((entry) =>
              entry.stream === next.stream ? next : entry,
            ),
          };
        });
        setNotice(
          `${VOLUME_LABELS[volume.stream] ?? volume.stream} volume updated.`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(null);
      }
    },
    [volumes],
  );

  const requestRole = useCallback(async (role: AndroidRoleName) => {
    setSaving(`role:${role}`);
    setError(null);
    setNotice(null);
    try {
      await System.requestRole({ role });
      const next = await System.getStatus();
      setSystemStatus(next);
      setNotice(`${ROLE_LABELS[role]} role updated.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }, []);

  const openSetting = useCallback(
    async (
      action: "settings" | "write" | "display" | "sound" | "network",
      label: string,
    ) => {
      setError(null);
      try {
        if (action === "settings") await System.openSettings();
        if (action === "write") await System.openWriteSettings();
        if (action === "display") await System.openDisplaySettings();
        if (action === "sound") await System.openSoundSettings();
        if (action === "network") await System.openNetworkSettings();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      setNotice(`${label} opened.`);
    },
    [],
  );

  return (
    <div
      data-testid="device-settings-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg pb-[var(--safe-area-bottom,0px)] pl-[var(--safe-area-left,0px)] pr-[var(--safe-area-right,0px)] pt-[var(--safe-area-top,0px)] supports-[height:100dvh]:h-[100dvh]"
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border/24 bg-bg/90 px-4 py-3 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-lg text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={t("nav.back", { defaultValue: "Back" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              {t("deviceSettings.title", {
                defaultValue: "Device Settings",
              })}
            </h1>
            <p className="truncate text-xs text-muted">
              {t("deviceSettings.subtitle", {
                defaultValue: "Brightness, volume, roles, and shortcuts",
              })}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 rounded-lg text-muted hover:text-txt"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t("actions.refresh", { defaultValue: "Refresh" })}
          data-testid="device-settings-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </header>

      {(error || notice) && (
        <div className="shrink-0 px-4 pt-3">
          <div
            role={error ? "alert" : "status"}
            className={`mx-auto max-w-6xl rounded-lg border px-3 py-2 text-sm ${
              error
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-border/30 bg-bg-accent text-muted"
            }`}
          >
            {error ?? notice}
          </div>
        </div>
      )}

      <main className="chat-native-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <section className="rounded-lg border border-border/24 bg-card/30 p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-accent">
                <Sun className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">Brightness</h2>
                <p className="text-xs text-muted">
                  {deviceSettings?.brightnessMode === "automatic"
                    ? "Adaptive brightness is currently enabled."
                    : "Set the device screen brightness."}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Level</span>
                <span className="font-mono text-txt">
                  {percent(brightness)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={percent(brightness)}
                onChange={(event) =>
                  setBrightness(Number(event.target.value) / 100)
                }
                className="w-full accent-info"
                aria-label="Brightness"
                data-testid="device-settings-brightness"
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted">
                  {deviceSettings?.canWriteSettings
                    ? "Write-settings permission is granted."
                    : "System brightness needs Android write-settings permission."}
                </div>
                <div className="flex items-center gap-2">
                  {!deviceSettings?.canWriteSettings ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void openSetting("write", "Write-settings permission")
                      }
                      data-testid="device-settings-open-write-settings"
                    >
                      Permission
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => void applyBrightness()}
                    disabled={saving === "brightness"}
                    data-testid="device-settings-apply-brightness"
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border/24 bg-card/30 p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-accent">
                <Settings className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">
                  Android settings
                </h2>
                <p className="text-xs text-muted">
                  Jump to the device panels that still require system UI.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
              <Button
                variant="outline"
                className="justify-start rounded-lg"
                onClick={() => void openSetting("settings", "System settings")}
                data-testid="device-settings-open-system"
              >
                <MonitorCog className="mr-2 h-4 w-4" />
                System settings
              </Button>
              <Button
                variant="outline"
                className="justify-start rounded-lg"
                onClick={() => void openSetting("display", "Display settings")}
                data-testid="device-settings-open-display"
              >
                <Sun className="mr-2 h-4 w-4" />
                Display
              </Button>
              <Button
                variant="outline"
                className="justify-start rounded-lg"
                onClick={() => void openSetting("sound", "Sound settings")}
                data-testid="device-settings-open-sound"
              >
                <Volume2 className="mr-2 h-4 w-4" />
                Sound
              </Button>
              <Button
                variant="outline"
                className="justify-start rounded-lg"
                onClick={() => void openSetting("network", "Network settings")}
                data-testid="device-settings-open-network"
              >
                <Wifi className="mr-2 h-4 w-4" />
                Network
              </Button>
            </div>
          </section>

          <section className="rounded-lg border border-border/24 bg-card/30 p-4 lg:col-span-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-accent">
                <Volume2 className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">Volume</h2>
                <p className="text-xs text-muted">
                  Control Android audio streams exposed by the system bridge.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {orderedVolumes.map((volume) => {
                const value = volumes[volume.stream] ?? volume.current;
                const label = VOLUME_LABELS[volume.stream] ?? volume.stream;
                return (
                  <div
                    key={volume.stream}
                    className="rounded-lg border border-border/20 bg-bg/50 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        {volume.stream === "notification" ? (
                          <Bell className="h-4 w-4 text-muted" />
                        ) : (
                          <Volume2 className="h-4 w-4 text-muted" />
                        )}
                        <div className="text-sm font-medium text-txt">
                          {label}
                        </div>
                      </div>
                      <div className="font-mono text-xs text-muted">
                        {streamPercent({ ...volume, current: value })}%
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={volume.max}
                        value={value}
                        onChange={(event) =>
                          setVolumes((current) => ({
                            ...current,
                            [volume.stream]: Number(event.target.value),
                          }))
                        }
                        className="min-w-0 flex-1 accent-info"
                        aria-label={`${label} volume`}
                        data-testid={`device-settings-volume-${volume.stream}`}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-lg"
                        onClick={() => void applyVolume(volume)}
                        disabled={saving === `volume:${volume.stream}`}
                        data-testid={`device-settings-apply-volume-${volume.stream}`}
                      >
                        Apply
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!loading && orderedVolumes.length === 0 ? (
                <div className="rounded-lg border border-border/20 bg-bg/50 px-4 py-6 text-center text-sm text-muted md:col-span-2">
                  Volume streams are not available in this runtime.
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-lg border border-border/24 bg-card/30 p-4 lg:col-span-2">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-accent">
                <ShieldCheck className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">
                  Default roles
                </h2>
                <p className="text-xs text-muted">
                  Manage Android system roles this device app can own.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {roles.map((role) => (
                <div
                  key={role.role}
                  className="rounded-lg border border-border/20 bg-bg/50 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-txt">
                        {ROLE_LABELS[role.role]}
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs text-muted">
                        {roleStatusLabel(role)}
                      </div>
                    </div>
                    {role.held ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-ok" />
                    ) : (
                      <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted" />
                    )}
                  </div>
                  <Button
                    variant={role.held ? "ghost" : "outline"}
                    size="sm"
                    className="mt-3 w-full rounded-lg"
                    disabled={
                      !role.available ||
                      role.held ||
                      saving === `role:${role.role}`
                    }
                    onClick={() => void requestRole(role.role)}
                    data-testid={`device-settings-request-role-${role.role}`}
                  >
                    {role.held ? "Assigned" : "Set role"}
                  </Button>
                </div>
              ))}
              {!loading && roles.length === 0 ? (
                <div className="rounded-lg border border-border/20 bg-bg/50 px-4 py-6 text-center text-sm text-muted md:col-span-2 xl:col-span-4">
                  Android role status is not available in this runtime.
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
