// Renders AOSP setup flasher UI controls and installer state.
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  IosApp,
  IosAuthState,
  IosDevice,
  IosInstallPlan,
  IosInstallStep,
  IosInstallStepId,
  IosInstallStepStatus,
} from "../backend/ios-types";
import { authorizedFetch, backendRoute } from "../runtime/server-url";

// ── Design tokens ──────────────────────────────────────────────────────────────
const C = {
  accent: "#ff6a1f",
  accentDim: "#ff8a24",
  text: "#fdfaf7",
  muted: "#8a8a94",
  error: "#f6465d",
  border: "#232329",
};

const s = {
  root: {
    background: "transparent",
    color: C.text,
    fontFamily: "'Poppins', system-ui, -apple-system, sans-serif",
    minHeight: "100%",
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "stretch",
    padding: "clamp(28px, 5vw, 48px)",
  },
  card: {
    background: "transparent",
    borderRadius: 0,
    border: "none",
    padding: 0,
    width: "100%",
    maxWidth: "720px",
    boxShadow: "none",
    margin: "0 auto",
  },
  heading: {
    fontSize: "clamp(22px, 3vw, 28px)",
    fontWeight: 600,
    letterSpacing: "-0.02em",
    lineHeight: 1.2,
    margin: "0 0 12px",
  },
  subheading: {
    fontSize: "15px",
    color: C.muted,
    margin: "0 0 24px",
    lineHeight: 1.6,
  },
  button: {
    background: C.accent,
    color: "#050506",
    border: "none",
    borderRadius: "8px",
    padding: "13px 18px",
    fontSize: "14px",
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    marginTop: "16px",
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  buttonSecondary: {
    background: "#17171c",
    color: C.text,
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    padding: "13px 18px",
    fontSize: "14px",
    cursor: "pointer",
    width: "100%",
    marginTop: "8px",
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  input: {
    background: "#17171c",
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    color: C.text,
    fontSize: "15px",
    padding: "14px 16px",
    width: "100%",
    boxSizing: "border-box" as const,
    marginBottom: "12px",
  },
  label: {
    fontSize: "13px",
    color: C.muted,
    display: "block",
    marginBottom: "6px",
  },
  notice: {
    background: "#17171c",
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    padding: "16px 18px",
    fontSize: "13px",
    lineHeight: 1.6,
    color: C.muted,
    marginBottom: "16px",
  },
  stepRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 0",
    borderBottom: `1px solid ${C.border}`,
  },
  appCard: {
    background: "#17171c",
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    padding: "18px",
    marginBottom: "12px",
    cursor: "pointer",
    width: "100%",
    color: C.text,
    textAlign: "left" as const,
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  spinner: {
    display: "inline-block",
    width: "20px",
    height: "20px",
    border: `3px solid ${C.border}`,
    borderTop: `3px solid ${C.accent}`,
    borderRadius: "50%",
    animation: "spin 0.8s linear infinite",
  },
  progressBar: {
    background: "#e8e9ed",
    borderRadius: "4px",
    height: "6px",
    overflow: "hidden",
    marginTop: "20px",
  },
  progressFill: (pct: number) => ({
    background: C.accent,
    height: "100%",
    width: `${pct}%`,
    borderRadius: "4px",
  }),
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function stepIcon(status: IosInstallStepStatus): string {
  switch (status) {
    case "complete":
      return "✅";
    case "failed":
      return "❌";
    case "running":
      return "⏳";
    case "waiting-user":
      return "👤";
    default:
      return "○";
  }
}

function progressFromSteps(steps: IosInstallStep[]): number {
  const total = steps.length;
  const done = steps.filter((s) => s.status === "complete").length;
  return Math.round((done / total) * 100);
}

type Screen =
  | "no-device"
  | "select-device"
  | "region-notice"
  | "select-app"
  | "confirm-install"
  | "apple-id-login"
  | "two-factor"
  | "installing"
  | "complete";

// ── Component ──────────────────────────────────────────────────────────────────

interface IosFlasherProps {
  serverUrl: string;
}

export function IosFlasher({ serverUrl }: IosFlasherProps) {
  const [screen, setScreen] = useState<Screen>("no-device");
  const [devices, setDevices] = useState<IosDevice[]>([]);
  const [apps, setApps] = useState<IosApp[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<IosDevice | null>(null);
  const [selectedApp, setSelectedApp] = useState<IosApp | null>(null);
  const [regionNotice, setRegionNotice] = useState<
    "eu-dma" | "japan-sca" | "worldwide"
  >("worldwide");
  const [plan, setPlan] = useState<IosInstallPlan | null>(null);
  const [steps, setSteps] = useState<IosInstallStep[]>([]);
  const [authState, setAuthState] = useState<IosAuthState>({ status: "idle" });
  const [appleId, setAppleId] = useState("");
  const [password, setPassword] = useState("");
  const [twoFaCode, setTwoFaCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const regionShownRef = useRef(false);

  // ── Polling for devices ──
  const stopScanning = useCallback(() => {
    if (scanIntervalRef.current !== null) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
  }, []);

  const scanDevices = useCallback(async (): Promise<
    "found" | "none" | "unavailable"
  > => {
    try {
      const res = await authorizedFetch(
        backendRoute(serverUrl, "/ios/devices"),
      );
      if (!res.ok) return "unavailable";
      const data = (await res.json()) as IosDevice[];
      setDevices(data);

      if (data.length > 0 && !regionShownRef.current) {
        setScanMessage(null);
        regionShownRef.current = true;

        // Fetch region notice and apps in parallel
        const [regionRes, appsRes] = await Promise.all([
          authorizedFetch(backendRoute(serverUrl, "/ios/region")),
          authorizedFetch(backendRoute(serverUrl, "/ios/apps")),
        ]);
        if (regionRes.ok)
          setRegionNotice(
            (await regionRes.json()) as "eu-dma" | "japan-sca" | "worldwide",
          );
        if (appsRes.ok) setApps((await appsRes.json()) as IosApp[]);

        if (data.length === 1) {
          setSelectedDevice(data[0] ?? null);
          setScreen("region-notice");
        } else {
          // Multiple devices — let the user pick.
          setScreen("select-device");
        }
        stopScanning();
        return "found";
      }
      return data.length > 0 ? "found" : "none";
    } catch {
      // The background poll keeps trying; an explicit check surfaces a
      // friendly recovery message through handleCheckForDevice.
      return "unavailable";
    }
  }, [serverUrl, stopScanning]);

  useEffect(() => {
    scanIntervalRef.current = setInterval(scanDevices, 2000);
    scanDevices();
    return () => stopScanning();
  }, [scanDevices, stopScanning]); // intentional: set up once on mount

  // ── Handlers ──
  async function handleContinueFromRegion() {
    setScreen("select-app");
  }

  async function handleSelectApp(app: IosApp) {
    setSelectedApp(app);
    setScreen("confirm-install");
  }

  function handleSelectDevice(device: IosDevice) {
    setSelectedDevice(device);
    setScreen("region-notice");
  }

  function handleConfirmInstall() {
    setScreen("apple-id-login");
  }

  async function handleCheckForDevice() {
    setLoading(true);
    setScanMessage(null);
    regionShownRef.current = false;
    if (scanIntervalRef.current === null) {
      scanIntervalRef.current = setInterval(scanDevices, 2000);
    }
    const result = await scanDevices();
    if (result === "none") {
      setScanMessage(
        "No iPhone or iPad found yet. Check the cable, unlock it, and tap Trust, then try again.",
      );
    } else if (result === "unavailable") {
      setScanMessage(
        "The installer couldn't check for devices. Wait a moment, then try again.",
      );
    }
    setLoading(false);
  }

  async function handleAppleIdLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!appleId.trim() || !password) return;
    setError(null);
    setLoading(true);
    try {
      const res = await authorizedFetch(
        backendRoute(serverUrl, "/ios/authenticate"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appleId, password }),
        },
      );
      const data = (await res.json()) as IosAuthState;
      setAuthState(data);
      if (data.status === "awaiting-2fa") {
        setScreen("two-factor");
      } else if (data.status === "authenticated") {
        await handleStartInstall(data);
      } else {
        setError(data.errorMessage ?? "Authentication failed");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      setPassword(""); // Never keep password in state after request
    }
  }

  async function handleSubmit2fa(e: React.FormEvent) {
    e.preventDefault();
    if (twoFaCode.length !== 6) return;
    setError(null);
    setLoading(true);
    try {
      const res = await authorizedFetch(backendRoute(serverUrl, "/ios/2fa"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: twoFaCode }),
      });
      const data = (await res.json()) as IosAuthState;
      setAuthState(data);
      if (data.status === "authenticated") {
        await handleStartInstall(data);
      } else {
        setError(data.errorMessage ?? "Invalid code");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleStartInstall(auth: IosAuthState) {
    if (!selectedDevice || !selectedApp) return;
    setLoading(true);
    setError(null);
    try {
      const planRes = await authorizedFetch(
        backendRoute(serverUrl, "/ios/plan"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceUdid: selectedDevice.udid,
            appId: selectedApp.id,
            appleId: auth.appleId ?? appleId,
          }),
        },
      );
      const planData = (await planRes.json()) as IosInstallPlan;
      setPlan(planData);
      setSteps(planData.steps);
      setScreen("installing");

      // SSE execute stream
      const execRes = await authorizedFetch(
        backendRoute(serverUrl, "/ios/execute"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: planData }),
        },
      );

      if (!execRes.body) throw new Error("No response body");
      const reader = execRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = JSON.parse(line.slice(6)) as {
            stepId?: IosInstallStepId;
            status?: IosInstallStepStatus;
            detail?: string;
            done?: boolean;
            error?: string;
          };
          if (payload.done) {
            setScreen("complete");
          } else if (payload.error) {
            setError(payload.error);
          } else if (payload.stepId && payload.status) {
            const nextStatus = payload.status;
            setSteps((prev) =>
              prev.map((step) =>
                step.id === payload.stepId
                  ? {
                      ...step,
                      status: nextStatus,
                      ...(payload.detail !== undefined
                        ? { detail: payload.detail }
                        : {}),
                    }
                  : step,
              ),
            );
          }
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // ── Render helpers ──
  function renderNoDeviceScreen() {
    return (
      <div style={s.card} className="ios-connect-card">
        <div className="ios-connect-copy">
          <p style={s.heading}>Connect your device</p>
          <ol className="connection-checklist">
            <li>
              <strong>Connect with a USB cable</strong>
              <span>Use a cable that supports data, not just charging.</span>
            </li>
            <li>
              <strong>Unlock your device</strong>
              <span>Keep it unlocked while the installer checks it.</span>
            </li>
            <li>
              <strong>Tap Trust if asked</strong>
              <span>Approve “Trust This Computer” on your device.</span>
            </li>
          </ol>
          <button
            style={s.button}
            type="button"
            disabled={loading}
            aria-busy={loading}
            onClick={() => void handleCheckForDevice()}
          >
            {loading ? "Looking for your device…" : "Check for my device"}
          </button>
          <p className="quiet-help" role={scanMessage ? "status" : undefined}>
            {scanMessage ??
              "The installer will continue when your device appears."}
          </p>
        </div>
      </div>
    );
  }

  function renderRegionNoticeScreen() {
    const content: Record<
      "eu-dma" | "japan-sca" | "worldwide",
      { emoji: string; body: string }
    > = {
      "eu-dma": {
        emoji: "🇪🇺",
        body: "EU users: You have a legal right under the Digital Markets Act to install apps outside the App Store. Sideloading is permitted in the European Union.",
      },
      "japan-sca": {
        emoji: "🇯🇵",
        body: "Japan: The Smartphone Software Competition Promotion Act gives you the right to install third-party apps on your iPhone or iPad.",
      },
      worldwide: {
        emoji: "ℹ️",
        body: "Sideloading uses a free Apple ID. The app certificate is valid for 7 days and must be renewed by re-running this installer.",
      },
    };
    const { emoji, body } = content[regionNotice];

    return (
      <div style={s.card}>
        <p style={{ ...s.heading, textAlign: "center" }}>
          {emoji} Before you begin
        </p>
        <div
          style={{
            ...s.notice,
            marginTop: "16px",
            fontSize: "14px",
            color: C.text,
          }}
        >
          {body}
        </div>
        <p style={{ ...s.subheading }}>
          elizaOS will be installed directly onto your device using your Apple
          ID. No jailbreak required.
        </p>
        <button
          style={s.button}
          type="button"
          onClick={handleContinueFromRegion}
        >
          Continue
        </button>
      </div>
    );
  }

  function renderSelectDeviceScreen() {
    return (
      <div style={s.card}>
        <p style={s.heading}>Multiple devices detected</p>
        <p style={s.subheading}>
          Pick the iPhone or iPad you want to install elizaOS on.
        </p>
        {devices.map((device) => (
          <button
            key={device.udid}
            style={s.appCard}
            type="button"
            onClick={() => handleSelectDevice(device)}
          >
            <div style={{ fontWeight: 700, marginBottom: "4px" }}>
              {device.name}
            </div>
            <div style={{ fontSize: "13px", color: C.muted }}>
              {device.model} · iOS {device.osVersion} · {device.connectionType}
            </div>
          </button>
        ))}
      </div>
    );
  }

  function renderConfirmInstallScreen() {
    const regionLabel: Record<typeof regionNotice, string> = {
      "eu-dma": "EU (Digital Markets Act)",
      "japan-sca": "Japan (Smartphone Competition Act)",
      worldwide: "Worldwide (7-day signing cert)",
    };
    return (
      <div style={s.card}>
        <p style={s.heading}>Review install</p>
        <div style={s.notice}>
          <div style={{ marginBottom: "6px" }}>
            <strong>App:</strong> {selectedApp?.name ?? "—"}
            {selectedApp ? ` v${selectedApp.version}` : ""}
          </div>
          <div style={{ marginBottom: "6px" }}>
            <strong>Device:</strong> {selectedDevice?.name ?? "—"} ·{" "}
            {selectedDevice?.model ?? ""} · iOS{" "}
            {selectedDevice?.osVersion ?? ""}
          </div>
          <div style={{ marginBottom: "6px" }}>
            <strong>Signed by:</strong>{" "}
            {appleId.trim() || "<your Apple ID — collected next>"}
          </div>
          <div>
            <strong>Region:</strong> {regionLabel[regionNotice]}
          </div>
        </div>
        <button style={s.button} type="button" onClick={handleConfirmInstall}>
          Continue to Apple ID
        </button>
        <button
          style={s.buttonSecondary}
          type="button"
          onClick={() => setScreen("select-app")}
        >
          Back
        </button>
      </div>
    );
  }

  function renderAuthStatusBanner() {
    if (authState.status === "authenticating") {
      return (
        <p style={{ ...s.subheading, color: C.accentDim }}>
          Sending credentials…
        </p>
      );
    }
    if (authState.status === "awaiting-2fa") {
      return (
        <p style={{ ...s.subheading, color: C.accentDim }}>Awaiting 2FA…</p>
      );
    }
    if (authState.status === "failed" && authState.errorMessage) {
      return (
        <p style={{ color: C.error, fontSize: "13px", marginBottom: "8px" }}>
          {authState.errorMessage}
        </p>
      );
    }
    return null;
  }

  function renderSelectAppScreen() {
    return (
      <div style={s.card}>
        <p style={s.heading}>Choose an app to install</p>
        <p style={s.subheading}>
          Device: <strong>{selectedDevice?.name ?? "Unknown"}</strong> — iOS{" "}
          {selectedDevice?.osVersion}
        </p>
        {apps.map((app) => (
          <button
            key={app.id}
            style={s.appCard}
            type="button"
            onClick={() => handleSelectApp(app)}
          >
            <div style={{ fontWeight: 700, marginBottom: "4px" }}>
              {app.name}
            </div>
            <div
              style={{ fontSize: "13px", color: C.muted, marginBottom: "6px" }}
            >
              v{app.version} · requires iOS {app.minOsVersion}
            </div>
            <div style={{ fontSize: "13px", color: C.text }}>
              {app.description}
            </div>
          </button>
        ))}
      </div>
    );
  }

  function renderAppleIdLoginScreen() {
    return (
      <div style={s.card}>
        <p style={s.heading}>Sign in with Apple ID</p>
        <div style={s.notice}>
          🔒 Your password is sent only to Apple servers — never stored or
          logged by this app.
        </div>
        <form onSubmit={handleAppleIdLogin}>
          <label htmlFor="apple-id-email" style={s.label}>
            Apple ID (email)
          </label>
          <input
            id="apple-id-email"
            style={s.input}
            type="email"
            autoComplete="email"
            value={appleId}
            onChange={(e) => setAppleId(e.target.value)}
            placeholder="you@icloud.com"
            required
          />
          <label htmlFor="apple-id-password" style={s.label}>
            Password
          </label>
          <input
            id="apple-id-password"
            style={s.input}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
          {renderAuthStatusBanner()}
          {error && (
            <p style={{ color: C.error, fontSize: "13px", margin: "0 0 8px" }}>
              {error}
            </p>
          )}
          <button style={s.button} type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
          <button
            style={s.buttonSecondary}
            type="button"
            onClick={() => {
              setError(null);
              setScreen("select-app");
            }}
          >
            Back
          </button>
        </form>
      </div>
    );
  }

  function renderTwoFactorScreen() {
    return (
      <div style={s.card}>
        <p style={s.heading}>Two-Factor Authentication</p>
        <p style={s.subheading}>
          Enter the 6-digit code sent to your Apple devices.
        </p>
        <form onSubmit={handleSubmit2fa}>
          <input
            style={{
              ...s.input,
              textAlign: "center",
              fontSize: "28px",
              letterSpacing: "8px",
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={twoFaCode}
            onChange={(e) => setTwoFaCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            required
          />
          {renderAuthStatusBanner()}
          {error && (
            <p style={{ color: C.error, fontSize: "13px", margin: "0 0 8px" }}>
              {error}
            </p>
          )}
          <button
            style={s.button}
            type="submit"
            disabled={loading || twoFaCode.length !== 6}
          >
            {loading ? "Verifying…" : "Verify"}
          </button>
        </form>
      </div>
    );
  }

  function renderInstallingScreen() {
    const pct = progressFromSteps(steps);
    return (
      <div style={s.card}>
        <p style={s.heading}>Installing…</p>
        {plan && (
          <p style={s.subheading}>
            {plan.app.name} v{plan.app.version} → {plan.device.name}
          </p>
        )}
        {steps.map((step, i) => (
          <div
            key={step.id}
            style={{
              ...s.stepRow,
              borderBottom:
                i < steps.length - 1 ? `1px solid ${C.border}` : "none",
            }}
          >
            <span style={{ fontSize: "18px", minWidth: "24px" }}>
              {stepIcon(step.status)}
            </span>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: step.status === "running" ? 700 : 400,
                }}
              >
                {step.label}
              </div>
              {step.detail && (
                <div
                  style={{ fontSize: "12px", color: C.muted, marginTop: "2px" }}
                >
                  {step.detail}
                </div>
              )}
            </div>
          </div>
        ))}
        <div style={s.progressBar}>
          <div style={s.progressFill(pct)} />
        </div>
        <p
          style={{
            textAlign: "right",
            fontSize: "12px",
            color: C.muted,
            marginTop: "6px",
          }}
        >
          {pct}%
        </p>
        {error && (
          <p style={{ color: C.error, fontSize: "13px", marginTop: "12px" }}>
            {error}
          </p>
        )}
      </div>
    );
  }

  function renderCompleteScreen() {
    return (
      <div style={s.card}>
        <p style={{ ...s.heading, textAlign: "center" }}>
          ✅ elizaOS installed!
        </p>
        <p style={{ ...s.subheading, textAlign: "center" }}>
          Open elizaOS on your {selectedDevice?.name ?? "device"} to get
          started.
        </p>
        {regionNotice === "worldwide" && (
          <div style={s.notice}>
            <strong>Renewal reminder:</strong> The sideloaded certificate
            expires in 7 days. Run this installer again before it expires to
            keep the app working.
          </div>
        )}
        <button
          style={s.button}
          type="button"
          onClick={() => {
            setScreen("no-device");
            regionShownRef.current = false;
            setSteps([]);
            setPlan(null);
            setError(null);
            scanIntervalRef.current = setInterval(scanDevices, 2000);
            void scanDevices();
          }}
        >
          Install on another device
        </button>
      </div>
    );
  }

  // ── Keyframe animation injection (once) ──
  useEffect(() => {
    const id = "ios-flasher-spin";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = "@keyframes spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  // ── Screen dispatch ──
  function renderScreen() {
    switch (screen) {
      case "no-device":
        return renderNoDeviceScreen();
      case "select-device":
        return renderSelectDeviceScreen();
      case "region-notice":
        return renderRegionNoticeScreen();
      case "select-app":
        return renderSelectAppScreen();
      case "confirm-install":
        return renderConfirmInstallScreen();
      case "apple-id-login":
        return renderAppleIdLoginScreen();
      case "two-factor":
        return renderTwoFactorScreen();
      case "installing":
        return renderInstallingScreen();
      case "complete":
        return renderCompleteScreen();
    }
  }

  return (
    <div style={s.root}>
      <div className="ios-section-header">
        <h2>Install Eliza on iPhone or iPad</h2>
        <p>
          Connect your device to install the Eliza app outside the App Store.
        </p>
      </div>
      {renderScreen()}
    </div>
  );
}
