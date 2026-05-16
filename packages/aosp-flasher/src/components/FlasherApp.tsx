import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AospBuild,
  AospFlasherBackend,
  ConnectedDevice,
  FlashPlan,
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
      return "⏳";
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
// Confirmation modal
// ---------------------------------------------------------------------------

interface ConfirmModalProps {
  device: ConnectedDevice;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ device, onConfirm, onCancel }: ConfirmModalProps) {
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <h2>Confirm flash — this cannot be undone</h2>
        <p className="modal-warning">
          This will <strong>ERASE ALL DATA</strong> on{" "}
          <strong>
            {device.model} ({device.serial})
          </strong>{" "}
          and install elizaOS. The device will be wiped completely.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn-danger" onClick={onConfirm}>
            Yes, flash now
          </button>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
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
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [builds, setBuilds] = useState<AospBuild[]>([]);
  const [selectedSerial, setSelectedSerial] = useState("");
  const [selectedBuildId, setSelectedBuildId] = useState("");
  const [wipeData, setWipeData] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<FlashPlan | null>(null);
  const [steps, setSteps] = useState<FlashStep[]>([]);
  const [executing, setExecuting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // -------------------------------------------------------------------------
  // Load devices + builds on mount
  // -------------------------------------------------------------------------

  const loadData = useCallback(
    async (opts: { refreshDevices?: boolean } = {}) => {
      if (opts.refreshDevices) setRefreshing(true);
      else setLoading(true);

      setError(null);

      try {
        const [nextDevices, nextBuilds] = await Promise.all([
          backend.listConnectedDevices(),
          builds.length === 0 ? backend.listBuilds() : Promise.resolve(builds),
        ]);

        setDevices(nextDevices);
        if (builds.length === 0) setBuilds(nextBuilds);

        if (!selectedSerial && nextDevices[0]) {
          setSelectedSerial(nextDevices[0].serial);
        }
        if (!selectedBuildId && nextBuilds[0]) {
          setSelectedBuildId(nextBuilds[0].id);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const selectedDevice = useMemo(
    () => devices.find((d) => d.serial === selectedSerial),
    [devices, selectedSerial],
  );

  const compatibleBuilds = useMemo(() => {
    if (!selectedDevice) return builds;
    return builds.filter(
      (b) =>
        b.targetDevice === selectedDevice.codename ||
        b.targetDevice === "unknown",
    );
  }, [builds, selectedDevice]);

  const selectedBuild = useMemo(
    () => compatibleBuilds.find((b) => b.id === selectedBuildId),
    [compatibleBuilds, selectedBuildId],
  );

  const canFlash =
    acknowledged &&
    !dryRun &&
    selectedDevice !== undefined &&
    selectedBuild !== undefined &&
    !executing;

  const canPreview =
    selectedDevice !== undefined &&
    selectedBuild !== undefined &&
    !executing;

  // -------------------------------------------------------------------------
  // Preview flash plan (dry-run visualization)
  // -------------------------------------------------------------------------

  async function handlePreview() {
    if (!selectedDevice || !selectedBuild) return;
    setError(null);
    setPlan(null);
    setSteps([]);

    try {
      const newPlan = await backend.createFlashPlan({
        deviceSerial: selectedDevice.serial,
        buildId: selectedBuild.id,
        wipeData,
        dryRun: true,
      });
      setPlan(newPlan);
      setSteps(newPlan.steps.map((s) => ({ ...s })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // -------------------------------------------------------------------------
  // Execute flash plan
  // -------------------------------------------------------------------------

  async function handleFlash() {
    if (!selectedDevice || !selectedBuild) return;
    setError(null);
    setExecuting(true);
    setShowConfirm(false);

    try {
      const newPlan = await backend.createFlashPlan({
        deviceSerial: selectedDevice.serial,
        buildId: selectedBuild.id,
        wipeData,
        dryRun: false,
      });
      setPlan(newPlan);
      // Initialise step list from plan
      setSteps(newPlan.steps.map((s) => ({ ...s, status: "pending" as const })));

      await backend.executeFlashPlan(
        newPlan,
        (stepId: FlashStepId, status: FlashStepStatus, detail: string) => {
          setSteps((prev) =>
            prev.map((s) =>
              s.id === stepId ? { ...s, status, detail } : s,
            ),
          );
        },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExecuting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <main className="flasher-shell">
      {showConfirm && selectedDevice && (
        <ConfirmModal
          device={selectedDevice}
          onConfirm={() => void handleFlash()}
          onCancel={() => setShowConfirm(false)}
        />
      )}

      {/* Header */}
      <section className="header-band">
        <div>
          <p className="eyebrow">elizaOS media tool</p>
          <h1>AOSP Flasher</h1>
        </div>
        {dryRun ? (
          <span className="status-pill">Dry-run mode</span>
        ) : (
          <span className="status-pill status-danger">Live flash mode</span>
        )}
      </section>

      <section className="workspace-grid">
        {/* Device panel */}
        <div className="panel">
          <div className="panel-header">
            <h2>Connected device</h2>
            <button
              type="button"
              className="btn-small"
              disabled={refreshing}
              onClick={() => void loadData({ refreshDevices: true })}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {loading ? (
            <p className="muted">Scanning for devices...</p>
          ) : devices.length === 0 ? (
            <p className="muted">
              No devices found — enable USB debugging and connect your Pixel
            </p>
          ) : (
            <div className="device-list" role="radiogroup" aria-label="Target device">
              {devices.map((device) => (
                <label
                  key={device.serial}
                  className={`device-row ${device.serial === selectedSerial ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="device"
                    value={device.serial}
                    checked={device.serial === selectedSerial}
                    onChange={() => setSelectedSerial(device.serial)}
                  />
                  <span>
                    <strong>{device.model}</strong>
                    <span className="muted">
                      {device.serial} · {device.codename} · {device.state}
                    </span>
                    {device.bootloaderUnlocked === true && (
                      <span className="tag tag-ok">Bootloader unlocked</span>
                    )}
                    {device.bootloaderUnlocked === false && (
                      <span className="tag tag-warn">Bootloader locked</span>
                    )}
                  </span>
                  <span className={`state-badge state-${device.state}`}>
                    {device.state}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Build panel */}
        <div className="panel">
          <h2>Build</h2>
          {builds.length === 0 ? (
            <p className="muted">Loading builds...</p>
          ) : (
            <>
              <label className="field">
                <span>Release</span>
                <select
                  value={selectedBuildId}
                  onChange={(e) => setSelectedBuildId(e.target.value)}
                >
                  {compatibleBuilds.map((build) => (
                    <option key={build.id} value={build.id}>
                      {build.label} {build.version}
                    </option>
                  ))}
                </select>
              </label>

              {selectedBuild && (
                <dl className="build-details">
                  <div>
                    <dt>Channel</dt>
                    <dd>{selectedBuild.channel}</dd>
                  </div>
                  <div>
                    <dt>Target device</dt>
                    <dd>{selectedBuild.targetDevice}</dd>
                  </div>
                  <div>
                    <dt>Architecture</dt>
                    <dd>{selectedBuild.architecture}</dd>
                  </div>
                  <div>
                    <dt>Published</dt>
                    <dd>
                      {new Date(selectedBuild.publishedAt).toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{formatBytes(selectedBuild.sizeBytes)}</dd>
                  </div>
                </dl>
              )}
            </>
          )}
        </div>

        {/* Options + action panel */}
        <div className="panel action-panel">
          <h2>Options</h2>

          <label className="ack-row">
            <input
              type="checkbox"
              checked={wipeData}
              onChange={(e) => setWipeData(e.target.checked)}
            />
            <span>
              Wipe data (<code>fastboot -w</code>) — erases userdata partition
            </span>
          </label>

          <label className="ack-row">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => {
                setDryRun(e.target.checked);
                if (e.target.checked) setAcknowledged(false);
              }}
            />
            <span>Dry-run only (recommended — never touches device)</span>
          </label>

          {!dryRun && (
            <label className="ack-row ack-danger">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I understand this will erase my device and cannot be undone
              </span>
            </label>
          )}

          <div className="action-buttons">
            <button
              type="button"
              disabled={!canPreview}
              onClick={() => void handlePreview()}
            >
              Preview flash plan
            </button>

            <button
              type="button"
              className="btn-danger"
              disabled={!canFlash}
              onClick={() => setShowConfirm(true)}
            >
              Flash device
            </button>
          </div>

          {error && <p className="error">{error}</p>}
        </div>

        {/* Progress panel */}
        {(steps.length > 0 || executing) && (
          <div className="panel progress-panel">
            <h2>
              {executing ? "Flashing in progress..." : plan?.steps && !executing ? "Flash plan" : "Progress"}
            </h2>
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
          </div>
        )}
      </section>

      {/* Footer */}
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
