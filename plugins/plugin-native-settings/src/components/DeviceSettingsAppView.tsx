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
import { Button, Input } from "@elizaos/ui";
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

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampVolumeValue(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const upper = Number.isFinite(max) && max > 0 ? Math.trunc(max) : 0;
  return Math.min(upper, Math.max(0, Math.trunc(value)));
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
      setBrightness(clampUnit(settingsResult.brightness));
    } catch (err) {
      // error-policy:J4 surface the load failure into the view's error state (three-state UI)
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
        deviceSettings.volumes.map((volume) => [
          volume.stream,
          clampVolumeValue(volume.current, volume.max),
        ]),
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
    const nextBrightness = clampUnit(brightness);
    setSaving("brightness");
    setError(null);
    setNotice(null);
    try {
      const next = await System.setScreenBrightness({
        brightness: nextBrightness,
      });
      setDeviceSettings(next);
      setBrightness(clampUnit(next.brightness));
      setNotice("Brightness updated.");
    } catch (err) {
      // error-policy:J4 surface the brightness-save failure into the view's error state
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }, [brightness]);

  const applyVolume = useCallback(
    async (volume: SystemVolumeStatus) => {
      const nextValue = clampVolumeValue(
        volumes[volume.stream] ?? volume.current,
        volume.max,
      );
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
              entry.stream === next.stream
                ? {
                    ...next,
                    current: clampVolumeValue(next.current, next.max),
                  }
                : entry,
            ),
          };
        });
        setNotice(
          `${VOLUME_LABELS[volume.stream] ?? volume.stream} volume updated.`,
        );
      } catch (err) {
        // error-policy:J4 surface the volume-save failure into the view's error state
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
      // error-policy:J4 surface the role-request failure into the view's error state
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
        // error-policy:J4 surface the open-settings failure into the view's error state
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
      <header className="flex shrink-0 items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 text-muted hover:text-txt"
            onClick={exitToApps}
            aria-label={t("nav.back", { defaultValue: "Back" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt">
              {t("deviceSettings.title", {
                defaultValue: "Device",
              })}
            </h1>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted hover:text-txt"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t("actions.refresh", { defaultValue: "Refresh" })}
          data-testid="device-settings-refresh"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </header>

      {(error || notice) && (
        <div className="shrink-0 px-3 pt-2">
          <div
            role={error ? "alert" : "status"}
            className={`mx-auto max-w-3xl px-1 py-2 text-sm ${
              error ? "text-danger" : "text-muted"
            }`}
          >
            {error ?? notice}
          </div>
        </div>
      )}

      <main className="chat-native-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <section className="py-2">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center">
                <Sun className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">Brightness</h2>
                <div className="text-xs text-muted">
                  {deviceSettings?.brightnessMode === "automatic"
                    ? "Adaptive"
                    : "Manual"}
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Level</span>
                <span className="font-mono text-txt">
                  {percent(brightness)}%
                </span>
              </div>
              <Input
                type="range"
                min={0}
                max={100}
                value={percent(brightness)}
                onChange={(event) =>
                  setBrightness(clampUnit(Number(event.target.value) / 100))
                }
                className="h-auto w-full border-0 bg-transparent p-0 accent-info"
                aria-label="Brightness"
                data-testid="device-settings-brightness"
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="inline-flex items-center gap-1.5 text-xs text-muted">
                  <CheckCircle2
                    className={`h-3.5 w-3.5 ${
                      deviceSettings?.canWriteSettings
                        ? "text-ok"
                        : "text-muted"
                    }`}
                  />
                  {deviceSettings?.canWriteSettings
                    ? "Permission granted"
                    : "Permission needed"}
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

          <section className="py-2">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center">
                <Settings className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">Android</h2>
                <div className="sr-only">System panels</div>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => void openSetting("settings", "System settings")}
                data-testid="device-settings-open-system"
              >
                <MonitorCog className="mr-2 h-4 w-4" />
                System settings
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => void openSetting("display", "Display settings")}
                data-testid="device-settings-open-display"
              >
                <Sun className="mr-2 h-4 w-4" />
                Display
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => void openSetting("sound", "Sound settings")}
                data-testid="device-settings-open-sound"
              >
                <Volume2 className="mr-2 h-4 w-4" />
                Sound
              </Button>
              <Button
                variant="outline"
                className="justify-start"
                onClick={() => void openSetting("network", "Network settings")}
                data-testid="device-settings-open-network"
              >
                <Wifi className="mr-2 h-4 w-4" />
                Network
              </Button>
            </div>
          </section>

          <section className="py-2">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center">
                <Volume2 className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">Volume</h2>
                <div className="text-xs text-muted">
                  {orderedVolumes.length} streams
                </div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {orderedVolumes.map((volume) => {
                const value = volumes[volume.stream] ?? volume.current;
                const label = VOLUME_LABELS[volume.stream] ?? volume.stream;
                return (
                  <div
                    key={volume.stream}
                    data-testid={`device-settings-volume-card-${volume.stream}`}
                    className="p-2"
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
                      <Input
                        type="range"
                        min={0}
                        max={volume.max}
                        value={value}
                        onChange={(event) =>
                          setVolumes((current) => ({
                            ...current,
                            [volume.stream]: clampVolumeValue(
                              Number(event.target.value),
                              volume.max,
                            ),
                          }))
                        }
                        className="h-auto min-w-0 flex-1 border-0 bg-transparent p-0 accent-info"
                        aria-label={`${label} volume`}
                        data-testid={`device-settings-volume-${volume.stream}`}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        className=""
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
                <div className="px-4 py-6 text-center text-sm text-muted md:col-span-2">
                  Unavailable
                </div>
              ) : null}
            </div>
          </section>

          <section className="py-2">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center">
                <ShieldCheck className="h-5 w-5 text-muted" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-txt">
                  Default roles
                </h2>
                <div className="text-xs text-muted">{roles.length} roles</div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {roles.map((role) => (
                <div
                  key={role.role}
                  data-testid={`device-settings-role-card-${role.role}`}
                  className="p-2"
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
                    className="mt-3 w-full"
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
                <div className="px-4 py-6 text-center text-sm text-muted md:col-span-2 xl:col-span-4">
                  Unavailable
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
