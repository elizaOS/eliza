import {
  BatteryCharging,
  Bluetooth,
  CheckCircle2,
  Clipboard,
  Download,
  Glasses,
  Mic,
  RefreshCw,
  Settings2,
  Wifi,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  encodeBrightness,
  encodeClearScreen,
  encodeConnectionReady,
  encodeGetSerial,
  encodeMicCommand,
  encodeSilentMode,
  encodeTextPackets,
  type G1Event,
  type GlassSide,
  paginateDisplayText,
} from "../protocol.js";
import {
  getWebBluetoothG1Transport,
  WebBluetoothG1Transport,
} from "../transport/web-bluetooth.js";

type LensState = "idle" | "prompting" | "connected" | "failed";
type PlatformKey = "desktop" | "ios" | "android";

interface ReportEvent {
  at: string;
  type: string;
  detail: string;
}

interface HardwareReport {
  generatedAt: string;
  transport: string | null;
  connected: boolean;
  lenses: Record<GlassSide, LensState>;
  tests: Record<string, boolean>;
  events: ReportEvent[];
  wifi: {
    available: boolean;
    status: string;
    networks: string[];
  };
}

type BridgeResult = unknown;

type SmartglassesBridge = {
  requestWifiScan?: () => Promise<BridgeResult> | BridgeResult;
  requestWifiStatus?: () => Promise<BridgeResult> | BridgeResult;
  setWifiCredentials?: (
    ssid: string,
    password: string,
  ) => Promise<BridgeResult> | BridgeResult;
  sendWifiCredentials?: (
    ssid: string,
    password: string,
  ) => Promise<BridgeResult> | BridgeResult;
  rawBridge?: {
    callEvenApp?: (
      name: string,
      payload?: Record<string, unknown>,
    ) => Promise<BridgeResult> | BridgeResult;
  };
};

declare global {
  interface Window {
    __evenBridge?: SmartglassesBridge;
    __mentraBridge?: SmartglassesBridge;
    smartglassesHardwareReport?: HardwareReport;
  }
}

const PLATFORM_COPY: Record<
  PlatformKey,
  { label: string; primary: string; secondary: string }
> = {
  desktop: {
    label: "Desktop",
    primary: "Use the browser Bluetooth picker. The headset flow asks for both lenses and only marks connected when both are live.",
    secondary:
      "Chrome and Edge support Web Bluetooth on desktop. Keep the base plugged in and disconnect stale phone pairings if one lens stalls.",
  },
  ios: {
    label: "iOS",
    primary:
      "Use the bundled/native bridge when available. Safari does not expose Web Bluetooth for direct G1 pairing.",
    secondary:
      "The view still works as a bridge console inside an iOS host that provides headset and Wi-Fi commands.",
  },
  android: {
    label: "Android",
    primary:
      "Use the native bridge for headset pairing, Wi-Fi scan, and Wi-Fi credential delivery when the host exposes it.",
    secondary:
      "Direct browser BLE can work in Chrome, but native pairing is the reliable setup path on Android builds.",
  },
};

function now(): string {
  return new Date().toISOString();
}

function timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(id);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(id);
        reject(err);
      },
    );
  });
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getBridge(): SmartglassesBridge | null {
  if (typeof window === "undefined") return null;
  return window.__mentraBridge ?? window.__evenBridge ?? null;
}

function parseWifiNetworks(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const value = result as Record<string, unknown>;
  const networks = value.networks ?? value.networks_neo ?? value.results;
  if (!Array.isArray(networks)) return [];
  return networks
    .map((network) => {
      if (typeof network === "string") return network;
      if (network && typeof network === "object") {
        const record = network as Record<string, unknown>;
        return String(record.ssid ?? record.SSID ?? "");
      }
      return "";
    })
    .filter((network) => network.trim().length > 0);
}

async function callWifiBridge(
  bridge: SmartglassesBridge,
  command: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  if (command === "request_wifi_scan" && bridge.requestWifiScan) {
    return bridge.requestWifiScan();
  }
  if (command === "request_wifi_status" && bridge.requestWifiStatus) {
    return bridge.requestWifiStatus();
  }
  if (command === "set_wifi_credentials") {
    const ssid = String(payload?.ssid ?? "");
    const password = String(payload?.password ?? "");
    if (bridge.setWifiCredentials) {
      return bridge.setWifiCredentials(ssid, password);
    }
    if (bridge.sendWifiCredentials) {
      return bridge.sendWifiCredentials(ssid, password);
    }
  }
  return bridge.rawBridge?.callEvenApp?.(command, payload);
}

export function SmartglassesView() {
  const [transport, setTransport] = useState<WebBluetoothG1Transport | null>(
    null,
  );
  const [lenses, setLenses] = useState<Record<GlassSide, LensState>>({
    left: "idle",
    right: "idle",
  });
  const [events, setEvents] = useState<ReportEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testText, setTestText] = useState(
    "Eliza smartglasses connected. Display, mic, serial, settings.",
  );
  const [micEnabled, setMicEnabled] = useState(false);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [wifiStatus, setWifiStatus] = useState("Not checked");
  const [wifiNetworks, setWifiNetworks] = useState<string[]>([]);
  const [activePlatform, setActivePlatform] = useState<PlatformKey>("desktop");
  const [tests, setTests] = useState<Record<string, boolean>>({
    headsetConnected: false,
    init: false,
    display: false,
    serial: false,
    settings: false,
    microphone: false,
    eventStream: false,
  });

  const bridge = getBridge();
  const webBluetoothAvailable = Boolean(getWebBluetoothG1Transport());
  const headsetConnected =
    lenses.left === "connected" && lenses.right === "connected";
  const report = useMemo<HardwareReport>(
    () => ({
      generatedAt: now(),
      transport: transport?.name ?? (bridge ? "native-bridge" : null),
      connected: headsetConnected,
      lenses,
      tests,
      events,
      wifi: {
        available: Boolean(bridge),
        status: wifiStatus,
        networks: wifiNetworks,
      },
    }),
    [bridge, events, headsetConnected, lenses, tests, transport, wifiNetworks, wifiStatus],
  );

  function appendEvent(type: string, detail: string): void {
    setEvents((current) => [...current, { at: now(), type, detail }].slice(-80));
  }

  function markTest(id: string, value = true): void {
    setTests((current) => ({ ...current, [id]: value }));
  }

  async function connectHeadset(): Promise<void> {
    setBusy("connect");
    setError(null);
    try {
      const nextTransport = transport ?? new WebBluetoothG1Transport();
      setTransport(nextTransport);
      const eventDispose = nextTransport.onEvent((event: G1Event) => {
        markTest("eventStream");
        appendEvent(
          "event",
          `${event.side} ${event.type}${event.label ? ` ${event.label}` : ""}`,
        );
      });
      const audioDispose = nextTransport.onAudio((audio, _rate, side) => {
        appendEvent("audio", `${side} ${audio.byteLength} bytes`);
      });
      try {
        await connectLens(nextTransport, "left");
        await connectLens(nextTransport, "right");
      } catch (err) {
        eventDispose();
        audioDispose();
        throw err;
      }
      await nextTransport.write("left", encodeConnectionReady("left"));
      await nextTransport.write("right", encodeConnectionReady("right"));
      markTest("headsetConnected");
      markTest("init");
      appendEvent("connect", "Whole headset connected");
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function connectLens(
    nextTransport: WebBluetoothG1Transport,
    side: GlassSide,
  ): Promise<void> {
    setLenses((current) => ({ ...current, [side]: "prompting" }));
    appendEvent("pairing", `Select the ${side} lens in the Bluetooth picker`);
    try {
      await timeout(
        nextTransport.connectLens(side),
        20_000,
        `Timed out connecting the ${side} lens`,
      );
      setLenses((current) => ({ ...current, [side]: "connected" }));
      appendEvent("connect", `${side} lens connected`);
    } catch (err) {
      setLenses((current) => ({ ...current, [side]: "failed" }));
      throw err;
    }
  }

  async function requireTransport(): Promise<WebBluetoothG1Transport> {
    if (!transport || !headsetConnected) {
      throw new Error("Connect the whole headset before running this test");
    }
    return transport;
  }

  async function sendDisplay(): Promise<void> {
    setBusy("display");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      const pages = paginateDisplayText(testText);
      for (const page of pages) {
        for (const packet of encodeTextPackets(page, 1)) {
          await nextTransport.writeBoth(packet);
        }
      }
      markTest("display");
      appendEvent("display", `Sent ${pages.length} display page(s)`);
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearDisplay(): Promise<void> {
    setBusy("clear");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      await nextTransport.writeBoth(encodeClearScreen());
      appendEvent("display", "Cleared display");
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runHardwareCheck(): Promise<void> {
    setBusy("check");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      await nextTransport.write("left", encodeGetSerial());
      await nextTransport.writeBoth(encodeBrightness(32));
      await nextTransport.writeBoth(encodeSilentMode(false));
      markTest("serial");
      markTest("settings");
      appendEvent("test", "Requested serial and sent settings packets");
      await sendDisplay();
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
      setBusy(null);
    }
  }

  async function toggleMic(enabled: boolean): Promise<void> {
    setBusy(enabled ? "mic-on" : "mic-off");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      await nextTransport.write("right", encodeMicCommand(enabled));
      setMicEnabled(enabled);
      markTest("microphone");
      appendEvent("microphone", enabled ? "Enabled" : "Disabled");
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function scanWifi(): Promise<void> {
    setBusy("wifi-scan");
    setError(null);
    try {
      if (!bridge) throw new Error("No native smartglasses bridge is available");
      const result = await callWifiBridge(bridge, "request_wifi_scan");
      const networks = parseWifiNetworks(result);
      setWifiNetworks(networks);
      setWifiStatus(
        networks.length > 0
          ? `Found ${networks.length} network(s)`
          : "Scan requested; waiting for bridge results",
      );
      appendEvent("wifi", "Requested Wi-Fi scan through bridge");
    } catch (err) {
      setError(normalizeError(err));
      setWifiStatus(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function configureWifi(): Promise<void> {
    setBusy("wifi-configure");
    setError(null);
    try {
      if (!bridge) throw new Error("No native smartglasses bridge is available");
      if (!wifiSsid.trim()) throw new Error("Enter a Wi-Fi SSID");
      await callWifiBridge(bridge, "set_wifi_credentials", {
        ssid: wifiSsid.trim(),
        password: wifiPassword,
      });
      setWifiStatus(`Credentials sent for ${wifiSsid.trim()}`);
      appendEvent("wifi", `Sent credentials for ${wifiSsid.trim()}`);
    } catch (err) {
      setError(normalizeError(err));
      setWifiStatus(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function copyReport(): Promise<void> {
    window.smartglassesHardwareReport = report;
    await navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
    appendEvent("report", "Copied diagnostics report");
  }

  function downloadReport(): void {
    window.smartglassesHardwareReport = report;
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `smartglasses-report-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    appendEvent("report", "Downloaded diagnostics report");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg text-txt">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Glasses className="h-4 w-4 text-accent" />
              <h1 className="text-sm font-semibold">Smartglasses</h1>
            </div>
            <p className="mt-1 max-w-3xl text-xs text-muted">
              Whole-headset pairing, diagnostics, bridge Wi-Fi setup, and
              hardware test reporting.
            </p>
          </div>
          <StatusPill ok={headsetConnected} label={headsetConnected ? "Headset connected" : "Not connected"} />
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <section className="space-y-4">
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Setup</h2>
                <p className="mt-1 text-xs text-muted">
                  One flow connects both lenses and treats them as a single
                  headset.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void connectHeadset()}
                disabled={!webBluetoothAvailable || busy !== null}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Bluetooth className="h-4 w-4" />
                Connect Headset
              </button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <LensStatus side="left" state={lenses.left} />
              <LensStatus side="right" state={lenses.right} />
            </div>
            {!webBluetoothAvailable && (
              <p className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted">
                Web Bluetooth is not available in this browser. Use a native
                iOS/Android/Desktop bridge or open this view in Chrome or Edge.
              </p>
            )}
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Test</h2>
                <p className="mt-1 text-xs text-muted">
                  Exercise display, serial, settings, microphone, and event
                  paths before relying on the headset.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void runHardwareCheck()}
                disabled={!headsetConnected || busy !== null}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                Run Check
              </button>
            </div>
            <textarea
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
              rows={4}
              className="mt-4 w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton onClick={sendDisplay} disabled={!headsetConnected || busy !== null}>
                Send Display
              </ActionButton>
              <ActionButton onClick={clearDisplay} disabled={!headsetConnected || busy !== null}>
                Clear
              </ActionButton>
              <ActionButton onClick={() => toggleMic(!micEnabled)} disabled={!headsetConnected || busy !== null}>
                <Mic className="h-4 w-4" />
                {micEnabled ? "Mic Off" : "Mic On"}
              </ActionButton>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(tests).map(([id, ok]) => (
                <CheckRow key={id} ok={ok} label={labelForTest(id)} />
              ))}
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold">Wi-Fi</h2>
            </div>
            <p className="mt-1 text-xs text-muted">
              Available through native/bridge APIs. Direct G1 BLE does not
              expose a verified Wi-Fi provisioning packet in the reviewed
              upstreams.
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <input
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                placeholder="SSID"
                className="h-9 rounded-md border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={wifiPassword}
                onChange={(event) => setWifiPassword(event.target.value)}
                placeholder="Password"
                type="password"
                className="h-9 rounded-md border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton onClick={scanWifi} disabled={!bridge || busy !== null}>
                Scan
              </ActionButton>
              <ActionButton onClick={configureWifi} disabled={!bridge || busy !== null}>
                Configure Wi-Fi
              </ActionButton>
            </div>
            <p className="mt-3 text-xs text-muted">{wifiStatus}</p>
            {wifiNetworks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {wifiNetworks.slice(0, 8).map((network) => (
                  <span
                    key={network}
                    className="rounded-md bg-muted/30 px-2 py-1 text-xs text-muted"
                  >
                    {network}
                  </span>
                ))}
              </div>
            )}
          </Panel>
        </section>

        <aside className="space-y-4">
          <Panel>
            <h2 className="text-sm font-semibold">Platform Setup</h2>
            <div className="mt-3 grid grid-cols-3 gap-1 rounded-md bg-muted/20 p-1">
              {(Object.keys(PLATFORM_COPY) as PlatformKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActivePlatform(key)}
                  className={`h-8 rounded px-2 text-xs font-medium ${
                    activePlatform === key
                      ? "bg-bg text-txt shadow-sm"
                      : "text-muted hover:text-txt"
                  }`}
                >
                  {PLATFORM_COPY[key].label}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-txt">
              {PLATFORM_COPY[activePlatform].primary}
            </p>
            <p className="mt-2 text-xs text-muted">
              {PLATFORM_COPY[activePlatform].secondary}
            </p>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <BatteryCharging className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold">Report</h2>
            </div>
            <div className="mt-3 grid gap-2 text-xs">
              <ReportRow label="Transport" value={report.transport ?? "none"} />
              <ReportRow label="Bridge" value={bridge ? "available" : "none"} />
              <ReportRow label="Events" value={String(events.length)} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <ActionButton onClick={copyReport}>
                <Clipboard className="h-4 w-4" />
                Copy
              </ActionButton>
              <ActionButton onClick={downloadReport}>
                <Download className="h-4 w-4" />
                Download
              </ActionButton>
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold">Events</h2>
            </div>
            <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border/50 bg-muted/10">
              {events.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted">No events yet.</p>
              ) : (
                events
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div
                      key={`${event.at}:${event.type}:${event.detail}`}
                      className="border-b border-border/40 px-3 py-2 last:border-b-0"
                    >
                      <p className="text-xs font-medium text-txt">
                        {event.type}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {event.detail}
                      </p>
                    </div>
                  ))
              )}
            </div>
          </Panel>
        </aside>
      </div>
      {error && (
        <div className="mx-4 mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-4">
      {children}
    </div>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium ${
        ok
          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
          : "border-border bg-muted/20 text-muted"
      }`}
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function LensStatus({ side, state }: { side: GlassSide; state: LensState }) {
  const ok = state === "connected";
  return (
    <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <Glasses className="h-4 w-4 text-muted" />
        <span className="text-sm capitalize">{side}</span>
      </div>
      <StatusPill ok={ok} label={state} />
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-green-600" />
      ) : (
        <XCircle className="h-4 w-4 text-muted" />
      )}
      <span className="text-xs">{label}</span>
    </div>
  );
}

function ReportRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="truncate font-medium text-txt">{value}</span>
    </div>
  );
}

function labelForTest(id: string): string {
  const labels: Record<string, string> = {
    headsetConnected: "Whole headset",
    init: "Init packets",
    display: "Display",
    serial: "Serial request",
    settings: "Settings",
    microphone: "Microphone",
    eventStream: "Events",
  };
  return labels[id] ?? id;
}
