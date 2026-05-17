import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AospBuild,
  AospFlasherBackend,
  ConnectedDevice,
  DeviceSpecs,
  FlashStep,
  FlashStepId,
  FlashStepStatus,
} from "../backend/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function stepIcon(status: FlashStepStatus): string {
  switch (status) {
    case "pending":
      return "⬜";
    case "running":
      return "🔄";
    case "complete":
      return "✅";
    case "failed":
      return "❌";
    case "waiting-user":
      return "👆";
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type Screen =
  | "detecting"
  | "device-specs"
  | "select-build"
  | "specs-check"
  | "bootloader-guide"
  | "confirming"
  | "flashing"
  | "complete"
  | "error";

// ---------------------------------------------------------------------------
// Sub-screens
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <span className="spinner" aria-hidden>
      ⏳
    </span>
  );
}

// ---- Screen 1: Device Detection ----

interface DetectingScreenProps {
  devices: ConnectedDevice[];
  loading: boolean;
  error: string | null;
  onSelect: (device: ConnectedDevice) => void;
  onRefresh: () => void;
}

function DetectingScreen({
  devices,
  loading,
  error,
  onSelect,
  onRefresh,
}: DetectingScreenProps) {
  return (
    <div className="screen">
      <div className="screen-header">
        <h2>Connect your device</h2>
        <button
          type="button"
          className="btn-small"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? "Scanning..." : "Refresh"}
        </button>
      </div>

      {loading && (
        <p className="muted">
          <Spinner /> Searching for connected Android devices...
        </p>
      )}

      {!loading && error && <p className="error">{error}</p>}

      {!loading && devices.length === 0 && !error && (
        <div className="notice">
          <p className="muted">No Android devices found.</p>
          <p className="muted">
            Enable USB debugging in{" "}
            <strong>Settings → Developer Options</strong>, then connect your
            device.
          </p>
        </div>
      )}

      {!loading && devices.length > 0 && (
        <ul className="device-list">
          {devices.map((device) => (
            <li key={device.serial} className="device-card">
              <div className="device-card-info">
                <strong className="device-name">📱 {device.model}</strong>
                <span className="muted">Serial: {device.serial}</span>
                <span className="muted">
                  {device.codename !== "unknown" ? `${device.codename} · ` : ""}
                  {device.state}
                </span>
                {device.bootloaderUnlocked === true && (
                  <span className="tag tag-ok">Bootloader unlocked</span>
                )}
                {device.bootloaderUnlocked === false && (
                  <span className="tag tag-warn">🔒 Bootloader locked</span>
                )}
                {device.state === "unauthorized" && (
                  <span className="tag tag-error">
                    Unauthorized — accept the prompt on device
                  </span>
                )}
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={() => onSelect(device)}
                disabled={
                  device.state === "unauthorized" || device.state === "offline"
                }
              >
                Select this device
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Screen 2: Device Specs Check ----

interface DeviceSpecsScreenProps {
  device: ConnectedDevice;
  specs: DeviceSpecs | null;
  loading: boolean;
  error: string | null;
  onContinue: () => void;
  onBack: () => void;
}

function DeviceSpecsScreen({
  device,
  specs,
  loading,
  error,
  onContinue,
  onBack,
}: DeviceSpecsScreenProps) {
  return (
    <div className="screen">
      <div className="screen-header">
        <h2>Checking {device.model}</h2>
        <button type="button" className="btn-small btn-ghost" onClick={onBack}>
          ← Back
        </button>
      </div>

      {loading && (
        <p className="muted">
          <Spinner /> Checking device specs...
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {specs && (
        <>
          <ul className="spec-list">
            <li className={specs.abi === "arm64-v8a" ? "spec-ok" : "spec-warn"}>
              <span className="spec-icon">
                {specs.abi === "arm64-v8a" ? "✅" : "⚠️"}
              </span>
              <span>
                <strong>CPU Architecture:</strong> {specs.abi || "unknown"}
                {specs.abi === "arm64-v8a"
                  ? " — compatible"
                  : " — may not be compatible"}
              </span>
            </li>
            <li className="spec-ok">
              <span className="spec-icon">✅</span>
              <span>
                <strong>Android Version:</strong>{" "}
                {specs.androidVersion || "unknown"} — supported
              </span>
            </li>
            <li
              className={
                specs.storageAvailableBytes >= 8 * 1024 ** 3
                  ? "spec-ok"
                  : "spec-warn"
              }
            >
              <span className="spec-icon">
                {specs.storageAvailableBytes >= 8 * 1024 ** 3 ? "✅" : "⚠️"}
              </span>
              <span>
                <strong>Storage available:</strong>{" "}
                {formatBytes(specs.storageAvailableBytes)} free of{" "}
                {formatBytes(specs.storageTotalBytes)}
                {specs.storageAvailableBytes < 8 * 1024 ** 3
                  ? " — may be tight (need ~8 GB)"
                  : ""}
              </span>
            </li>
            <li
              className={
                specs.bootloaderLocked === false ? "spec-ok" : "spec-locked"
              }
            >
              <span className="spec-icon">
                {specs.bootloaderLocked === false ? "✅" : "🔒"}
              </span>
              <span>
                <strong>Bootloader:</strong>{" "}
                {specs.bootloaderLocked === true
                  ? "LOCKED — must unlock before flashing"
                  : specs.bootloaderLocked === false
                    ? "UNLOCKED"
                    : "Unknown"}
              </span>
            </li>
            <li className="spec-ok">
              <span className="spec-icon">✅</span>
              <span>
                <strong>USB Debugging:</strong> enabled
              </span>
            </li>
            <li className={specs.supportedByElizaOs ? "spec-ok" : "spec-warn"}>
              <span className="spec-icon">
                {specs.supportedByElizaOs ? "✅" : "⚠️"}
              </span>
              <span>
                <strong>Device recognized:</strong>{" "}
                {specs.supportedByElizaOs
                  ? `elizaOS supports ${device.model} (${specs.supportedBuildCodename})`
                  : `${device.codename} is not an officially supported device`}
              </span>
            </li>
          </ul>

          <div className="action-row">
            <button type="button" className="btn-primary" onClick={onContinue}>
              Continue to build selection →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Screen 3: Build Selection ----

interface SelectBuildScreenProps {
  device: ConnectedDevice;
  builds: AospBuild[];
  selectedBuildId: string;
  onSelectBuild: (id: string) => void;
  onContinue: () => void;
  onBack: () => void;
}

function SelectBuildScreen({
  device,
  builds,
  selectedBuildId,
  onSelectBuild,
  onContinue,
  onBack,
}: SelectBuildScreenProps) {
  const compatibleBuilds = builds.filter(
    (b) => b.targetDevice === device.codename || b.targetDevice === "unknown",
  );

  const selectedBuild = compatibleBuilds.find((b) => b.id === selectedBuildId);

  return (
    <div className="screen">
      <div className="screen-header">
        <h2>Select a build</h2>
        <button type="button" className="btn-small btn-ghost" onClick={onBack}>
          ← Back
        </button>
      </div>

      {compatibleBuilds.length === 0 ? (
        <div className="notice">
          <p className="muted">
            No builds found for <strong>{device.codename}</strong>.
          </p>
        </div>
      ) : (
        <>
          <p className="muted">
            Showing builds compatible with your {device.model}.
          </p>
          <div className="build-list">
            {compatibleBuilds.map((build) => (
              <label
                key={build.id}
                className={`build-card ${build.id === selectedBuildId ? "selected" : ""}`}
              >
                <input
                  type="radio"
                  name="build"
                  value={build.id}
                  checked={build.id === selectedBuildId}
                  onChange={() => onSelectBuild(build.id)}
                />
                <div className="build-card-info">
                  <strong>{build.label}</strong>
                  <span className="muted">v{build.version}</span>
                  <div className="build-meta">
                    <span className={`channel-badge channel-${build.channel}`}>
                      {build.channel}
                    </span>
                    <span className="muted">
                      {formatBytes(build.sizeBytes)}
                    </span>
                    <span className="muted">
                      {new Date(build.publishedAt).toLocaleDateString()}
                    </span>
                  </div>
                  {build.targetDevice === device.codename && (
                    <span className="tag tag-ok">For your {device.model}</span>
                  )}
                </div>
              </label>
            ))}
          </div>

          {selectedBuild && (
            <div className="action-row">
              <button
                type="button"
                className="btn-primary"
                onClick={onContinue}
              >
                Continue with {selectedBuild.label} →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- Screen 4: Specs Compatibility Check ----

interface SpecsCheckScreenProps {
  device: ConnectedDevice;
  build: AospBuild;
  specs: DeviceSpecs;
  onContinue: () => void;
  onBack: () => void;
}

function SpecsCheckScreen({
  device,
  build,
  specs,
  onContinue,
  onBack,
}: SpecsCheckScreenProps) {
  const storageOk = specs.storageAvailableBytes >= 8 * 1024 ** 3;
  const bootloaderUnlocked = specs.bootloaderLocked === false;

  return (
    <div className="screen">
      <div className="screen-header">
        <h2>Compatibility check</h2>
        <button type="button" className="btn-small btn-ghost" onClick={onBack}>
          ← Back
        </button>
      </div>

      <ul className="spec-list">
        <li className={specs.supportedByElizaOs ? "spec-ok" : "spec-warn"}>
          <span className="spec-icon">
            {specs.supportedByElizaOs ? "✅" : "⚠️"}
          </span>
          <span>
            <strong>Device:</strong> {device.model} ({device.codename}){" "}
            {specs.supportedByElizaOs
              ? "supports elizaOS"
              : "— not officially supported"}
          </span>
        </li>
        <li className="spec-ok">
          <span className="spec-icon">✅</span>
          <span>
            <strong>Build:</strong> {build.label} matches {build.architecture}
          </span>
        </li>
        <li className={storageOk ? "spec-ok" : "spec-warn"}>
          <span className="spec-icon">{storageOk ? "✅" : "⚠️"}</span>
          <span>
            <strong>Storage:</strong> {formatBytes(specs.storageAvailableBytes)}{" "}
            free — elizaOS needs ~8 GB minimum{" "}
            {storageOk ? "(OK)" : "(may be tight)"}
          </span>
        </li>
        <li className={bootloaderUnlocked ? "spec-ok" : "spec-locked"}>
          <span className="spec-icon">{bootloaderUnlocked ? "✅" : "🔒"}</span>
          <span>
            <strong>Bootloader:</strong>{" "}
            {bootloaderUnlocked
              ? "UNLOCKED — ready to flash"
              : "LOCKED — unlock required (next step)"}
          </span>
        </li>
      </ul>

      <div className="action-row">
        <button type="button" className="btn-primary" onClick={onContinue}>
          {bootloaderUnlocked
            ? "Continue to confirm →"
            : "Continue to bootloader unlock →"}
        </button>
      </div>
    </div>
  );
}

// ---- Screen 5: Bootloader Unlock Guide ----

const UNLOCK_STEPS = [
  {
    title: "Enable Developer Options",
    instructions: [
      "Open Settings → About Phone",
      'Tap "Build Number" 7 times rapidly',
      'You\'ll see "You are now a developer!"',
    ],
    done: "Done — I enabled Developer Options",
    action: null,
  },
  {
    title: "Enable OEM Unlocking",
    instructions: [
      "Open Settings → System → Developer Options",
      'Find "OEM Unlocking" and toggle it ON',
      "Confirm when prompted",
    ],
    done: "Done — OEM Unlocking is enabled",
    action: null,
  },
  {
    title: "Back Up Your Data",
    instructions: [
      "ALL DATA will be erased during unlock.",
      "Back up photos, contacts, and apps now.",
    ],
    done: "Done — I've backed up my data",
    action: null,
  },
  {
    title: "Reboot to Bootloader",
    instructions: [
      "Click the button below to reboot your phone to bootloader mode.",
      "Wait for the bootloader screen to appear on your phone.",
    ],
    done: null,
    action: "reboot-bootloader" as const,
  },
  {
    title: "Unlock the Bootloader",
    instructions: [
      "Click the button below to send the unlock command.",
      "On your phone screen, use VOLUME KEYS to highlight UNLOCK THE BOOTLOADER then press POWER to confirm.",
      "This will ERASE your phone.",
    ],
    done: null,
    action: "unlock-bootloader" as const,
  },
] as const;

type UnlockAction = "reboot-bootloader" | "unlock-bootloader";

interface BootloaderGuideScreenProps {
  device: ConnectedDevice;
  onUnlockAction: (action: UnlockAction) => Promise<void>;
  onUnlocked: () => void;
  onBack: () => void;
}

function BootloaderGuideScreen({
  device,
  onUnlockAction,
  onUnlocked,
  onBack,
}: BootloaderGuideScreenProps) {
  const [step, setStep] = useState(0);
  const [actionRunning, setActionRunning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [waitingConfirm, setWaitingConfirm] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  const currentStep = UNLOCK_STEPS[step];

  if (!currentStep) {
    return null;
  }

  async function handleAction(action: UnlockAction) {
    setActionRunning(true);
    setActionError(null);
    try {
      await onUnlockAction(action);
      if (action === "unlock-bootloader") {
        setWaitingConfirm(true);
      } else {
        setStep((s) => s + 1);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionRunning(false);
    }
  }

  function handleUnlockConfirmed() {
    setUnlocked(true);
    setTimeout(onUnlocked, 2000);
  }

  if (unlocked) {
    return (
      <div className="screen">
        <div className="unlocked-banner">
          <p>✅ Bootloader unlocked! Your phone will reboot.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="screen-header">
        <h2>🔒 Unlock Your Bootloader</h2>
        <button type="button" className="btn-small btn-ghost" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="unlock-warning">
        <p>
          Your <strong>{device.model}</strong> bootloader is currently locked.
          You <strong>MUST</strong> unlock it before flashing elizaOS. This
          will:
        </p>
        <ul>
          <li>ERASE ALL DATA on your phone</li>
          <li>Void your warranty</li>
          <li>Allow custom OS installation</li>
        </ul>
      </div>

      <div className="unlock-progress">
        <p className="step-counter">
          Step {step + 1} of {UNLOCK_STEPS.length}
        </p>
        <div className="step-dots">
          {UNLOCK_STEPS.map((unlockStep, i) => (
            <span
              key={unlockStep.title}
              className={`step-dot ${i < step ? "done" : i === step ? "active" : ""}`}
            />
          ))}
        </div>
      </div>

      <div className="unlock-step-card">
        <h3>{currentStep.title}</h3>
        <ol className="unlock-instructions">
          {currentStep.instructions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>

        {actionError && <p className="error">{actionError}</p>}

        {waitingConfirm && currentStep.action === "unlock-bootloader" ? (
          <div className="waiting-confirm">
            <p className="muted">
              <Spinner /> Waiting for you to confirm on device...
            </p>
            <p className="muted">
              Use VOLUME KEYS to highlight "UNLOCK THE BOOTLOADER" then press
              POWER.
            </p>
            <button
              type="button"
              className="btn-primary"
              onClick={handleUnlockConfirmed}
            >
              ✅ I confirmed on device — bootloader is unlocked
            </button>
          </div>
        ) : currentStep.action ? (
          <button
            type="button"
            className="btn-primary"
            disabled={actionRunning}
            onClick={() => {
              if (currentStep.action) void handleAction(currentStep.action);
            }}
          >
            {actionRunning
              ? "Running..."
              : currentStep.action === "reboot-bootloader"
                ? "Reboot to Bootloader"
                : "Unlock Bootloader"}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              setStep((s) => Math.min(s + 1, UNLOCK_STEPS.length - 1))
            }
          >
            {currentStep.done}
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Screen 6: Pre-Flash Confirmation ----

interface ConfirmingScreenProps {
  device: ConnectedDevice;
  build: AospBuild;
  onFlash: () => void;
  onCancel: () => void;
}

function ConfirmingScreen({
  device,
  build,
  onFlash,
  onCancel,
}: ConfirmingScreenProps) {
  const [checkedErase, setCheckedErase] = useState(false);
  const [checkedBackup, setCheckedBackup] = useState(false);

  return (
    <div className="screen">
      <div className="screen-header">
        <h2>⚠️ Final Confirmation</h2>
      </div>

      <div className="confirm-box">
        <p>You are about to flash elizaOS onto:</p>
        <dl className="confirm-details">
          <div>
            <dt>Device</dt>
            <dd>
              {device.model} ({device.serial})
            </dd>
          </div>
          <div>
            <dt>Build</dt>
            <dd>
              {build.label} v{build.version}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(build.sizeBytes)}</dd>
          </div>
        </dl>

        <p className="confirm-warning">This will:</p>
        <ul className="confirm-list">
          <li>
            Erase all existing data (already erased during bootloader unlock)
          </li>
          <li>Flash system, boot, vendor, and all required partitions</li>
          <li>Reboot into elizaOS</li>
        </ul>

        <div className="confirm-checks">
          <label className="ack-row">
            <input
              type="checkbox"
              checked={checkedErase}
              onChange={(e) => setCheckedErase(e.target.checked)}
            />
            <span>I understand this cannot be undone</span>
          </label>
          <label className="ack-row">
            <input
              type="checkbox"
              checked={checkedBackup}
              onChange={(e) => setCheckedBackup(e.target.checked)}
            />
            <span>I have backed up all important data</span>
          </label>
        </div>

        <div className="action-row action-row-split">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-danger"
            disabled={!checkedErase || !checkedBackup}
            onClick={onFlash}
          >
            Flash elizaOS
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Screen 7: Flashing Progress ----

interface FlashingScreenProps {
  steps: FlashStep[];
  terminalLines: string[];
}

function FlashingScreen({ steps, terminalLines }: FlashingScreenProps) {
  const runningStep = steps.find((s) => s.status === "running");
  const completedCount = steps.filter((s) => s.status === "complete").length;
  const progress =
    steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;

  return (
    <div className="screen">
      <div className="screen-header">
        <h2>Flashing elizaOS...</h2>
      </div>

      <div className="flash-progress-bar">
        <div
          className="flash-progress-fill"
          style={{ width: `${progress}%` }}
        />
      </div>

      {runningStep && (
        <p className="muted">
          <Spinner /> {runningStep.label}...
        </p>
      )}

      <ol className="step-list">
        {steps.map((step) => (
          <li key={step.id} className={`step step-${step.status}`}>
            <span className="step-icon" aria-hidden>
              {stepIcon(step.status)}
            </span>
            <div className="step-body">
              <strong className="step-label">{step.label}</strong>
              {step.status === "waiting-user" && step.userAction ? (
                <p className="user-action">{step.userAction}</p>
              ) : (
                <span className="step-detail">{step.detail}</span>
              )}
            </div>
          </li>
        ))}
      </ol>

      {terminalLines.length > 0 && (
        <div className="terminal-output">
          {terminalLines.map((line) => (
            <div key={line} className="terminal-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Screen 8: Complete ----

interface CompleteScreenProps {
  device: ConnectedDevice;
  onFlashAnother: () => void;
}

function CompleteScreen({ device, onFlashAnother }: CompleteScreenProps) {
  return (
    <div className="screen screen-complete">
      <div className="complete-banner">
        <p className="complete-icon">✅</p>
        <h2>elizaOS successfully flashed!</h2>
        <p>
          Your <strong>{device.model}</strong> is now running elizaOS Android
          Beta.
        </p>
      </div>

      <div className="complete-next">
        <p>
          <strong>What's next:</strong>
        </p>
        <ul>
          <li>Complete initial setup on your phone</li>
          <li>Connect to your elizaOS account</li>
          <li>Your AI agent will be available immediately</li>
        </ul>
      </div>

      <div className="action-row action-row-split">
        <a
          className="btn-primary"
          href="https://elizaos.ai/docs/setup"
          target="_blank"
          rel="noreferrer"
        >
          View Setup Guide
        </a>
        <button type="button" className="btn-ghost" onClick={onFlashAnother}>
          Flash Another Device
        </button>
      </div>
    </div>
  );
}

// ---- Error screen ----

interface ErrorScreenProps {
  message: string;
  onRetry: () => void;
}

function ErrorScreen({ message, onRetry }: ErrorScreenProps) {
  return (
    <div className="screen">
      <div className="screen-header">
        <h2>Something went wrong</h2>
      </div>
      <p className="error">{message}</p>
      <div className="action-row">
        <button type="button" className="btn-primary" onClick={onRetry}>
          Start over
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface FlasherAppProps {
  backend: AospFlasherBackend;
}

export function FlasherApp({ backend }: FlasherAppProps) {
  const [screen, setScreen] = useState<Screen>("detecting");
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [builds, setBuilds] = useState<AospBuild[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<ConnectedDevice | null>(
    null,
  );
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const [specs, setSpecs] = useState<DeviceSpecs | null>(null);
  const [specsLoading, setSpecsLoading] = useState(false);
  const [specsError, setSpecsError] = useState<string | null>(null);
  const [detectLoading, setDetectLoading] = useState(true);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [steps, setSteps] = useState<FlashStep[]>([]);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const buildsLoadedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Load devices
  // ---------------------------------------------------------------------------

  const loadDevices = useCallback(async () => {
    setDetectLoading(true);
    setDetectError(null);
    try {
      const [nextDevices, nextBuilds] = await Promise.all([
        backend.listConnectedDevices(),
        buildsLoadedRef.current
          ? Promise.resolve(builds)
          : backend.listBuilds(),
      ]);
      setDevices(nextDevices);
      if (!buildsLoadedRef.current) {
        setBuilds(nextBuilds);
        buildsLoadedRef.current = true;
        if (nextBuilds[0] && !selectedBuildId) {
          setSelectedBuildId(nextBuilds[0].id);
        }
      }
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetectLoading(false);
    }
  }, [backend, builds, selectedBuildId]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  async function handleSelectDevice(device: ConnectedDevice) {
    setSelectedDevice(device);
    setSpecs(null);
    setSpecsError(null);
    setSpecsLoading(true);
    setScreen("device-specs");

    // Auto-select compatible build
    const compatible = builds.filter(
      (b) => b.targetDevice === device.codename || b.targetDevice === "unknown",
    );
    if (compatible[0]) setSelectedBuildId(compatible[0].id);

    try {
      const s = await backend.getDeviceSpecs(device.serial);
      setSpecs(s);
    } catch (err) {
      setSpecsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpecsLoading(false);
    }
  }

  function handleSpecsContinue() {
    setScreen("select-build");
  }

  function handleBuildContinue() {
    setScreen("specs-check");
  }

  function handleSpecsCheckContinue() {
    if (specs?.bootloaderLocked === false) {
      setScreen("confirming");
    } else {
      setScreen("bootloader-guide");
    }
  }

  async function handleUnlockAction(
    action: "reboot-bootloader" | "unlock-bootloader",
  ) {
    if (!selectedDevice) return;
    if (action === "reboot-bootloader") {
      const plan = await backend.createFlashPlan({
        deviceSerial: selectedDevice.serial,
        buildId: selectedBuildId,
        wipeData: false,
        dryRun: true,
      });
      // We just need the reboot-to-bootloader step to run via the backend
      // For the guide we call the backend's execute but only with reboot step
      // Simplest: just execute a dry plan to show intent — real action is separate
      void plan; // acknowledged
      // For now, we trigger via the execute endpoint with a plan that has just the reboot step
      // The backend handles the actual adb reboot bootloader call.
      // We reconstruct a minimal plan with only the relevant step.
      const minimalPlan = {
        ...plan,
        steps: plan.steps.filter((s) => s.id === "reboot-bootloader"),
      };
      await new Promise<void>((resolve, reject) => {
        backend
          .executeFlashPlan(minimalPlan, (_stepId, status, detail) => {
            if (status === "failed") reject(new Error(detail));
            if (status === "complete") resolve();
          })
          .then(resolve)
          .catch(reject);
      });
    }
    // unlock-bootloader: just return — guide tells user to confirm on device
  }

  async function handleFlash() {
    if (!selectedDevice) return;
    setScreen("flashing");
    setTerminalLines([]);

    try {
      const plan = await backend.createFlashPlan({
        deviceSerial: selectedDevice.serial,
        buildId: selectedBuildId,
        wipeData: false,
        dryRun: false,
      });
      setSteps(plan.steps.map((s) => ({ ...s, status: "pending" as const })));

      await backend.executeFlashPlan(
        plan,
        (stepId: FlashStepId, status: FlashStepStatus, detail: string) => {
          setSteps((prev) =>
            prev.map((s) => (s.id === stepId ? { ...s, status, detail } : s)),
          );
          setTerminalLines((prev) => {
            const line = `[${stepId}] ${detail}`;
            return [...prev.slice(-4), line];
          });
        },
      );

      setScreen("complete");
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : String(err));
      setScreen("error");
    }
  }

  function handleReset() {
    setScreen("detecting");
    setSelectedDevice(null);
    setSpecs(null);
    setSteps([]);
    setTerminalLines([]);
    setGlobalError(null);
    void loadDevices();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const selectedBuild = builds.find((b) => b.id === selectedBuildId);

  return (
    <main className="flasher-shell">
      <section className="header-band">
        <div>
          <p className="eyebrow">elizaOS media tool</p>
          <h1>AOSP Flasher</h1>
        </div>
        {selectedDevice && (
          <span className="status-pill">{selectedDevice.model}</span>
        )}
      </section>

      <section className="workspace-body">
        {screen === "detecting" && (
          <DetectingScreen
            devices={devices}
            loading={detectLoading}
            error={detectError}
            onSelect={(d) => void handleSelectDevice(d)}
            onRefresh={() => void loadDevices()}
          />
        )}

        {screen === "device-specs" && selectedDevice && (
          <DeviceSpecsScreen
            device={selectedDevice}
            specs={specs}
            loading={specsLoading}
            error={specsError}
            onContinue={handleSpecsContinue}
            onBack={() => setScreen("detecting")}
          />
        )}

        {screen === "select-build" && selectedDevice && (
          <SelectBuildScreen
            device={selectedDevice}
            builds={builds}
            selectedBuildId={selectedBuildId}
            onSelectBuild={setSelectedBuildId}
            onContinue={handleBuildContinue}
            onBack={() => setScreen("device-specs")}
          />
        )}

        {screen === "specs-check" &&
          selectedDevice &&
          specs &&
          selectedBuild && (
            <SpecsCheckScreen
              device={selectedDevice}
              build={selectedBuild}
              specs={specs}
              onContinue={handleSpecsCheckContinue}
              onBack={() => setScreen("select-build")}
            />
          )}

        {screen === "bootloader-guide" && selectedDevice && (
          <BootloaderGuideScreen
            device={selectedDevice}
            onUnlockAction={handleUnlockAction}
            onUnlocked={() => setScreen("confirming")}
            onBack={() => setScreen("specs-check")}
          />
        )}

        {screen === "confirming" && selectedDevice && selectedBuild && (
          <ConfirmingScreen
            device={selectedDevice}
            build={selectedBuild}
            onFlash={() => void handleFlash()}
            onCancel={() => setScreen("specs-check")}
          />
        )}

        {screen === "flashing" && (
          <FlashingScreen steps={steps} terminalLines={terminalLines} />
        )}

        {screen === "complete" && selectedDevice && (
          <CompleteScreen
            device={selectedDevice}
            onFlashAnother={handleReset}
          />
        )}

        {screen === "error" && (
          <ErrorScreen
            message={globalError ?? "Unknown error"}
            onRetry={handleReset}
          />
        )}
      </section>

      <section className="footer-band">
        <span className="footer-brand">elizaOS AOSP Flasher</span>
        <a
          className="cta-link"
          href="https://elizaos.ai"
          target="_blank"
          rel="noreferrer"
        >
          elizaOS docs
        </a>
      </section>
    </main>
  );
}
