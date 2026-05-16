import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
} from "../backend/types";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex] ?? "B"}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppStep =
  | "selecting-drive"
  | "selecting-image"
  | "specs-check"
  | "confirming"
  | "writing"
  | "complete"
  | "error";

interface SpecItem {
  key: string;
  label: string;
  status: "pass" | "fail" | "warn" | "checking";
  detail: string;
}

interface InstallerAppProps {
  backend: UsbInstallerBackend;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SafetyBadge({ safety }: { safety: RemovableDrive["safety"] }) {
  if (safety === "safe-removable") {
    return (
      <span className="badge badge-safe">Safe to write</span>
    );
  }
  if (safety === "blocked-system") {
    return (
      <span className="badge badge-blocked">SYSTEM DISK — BLOCKED</span>
    );
  }
  return <span className="badge badge-unknown">Unknown</span>;
}

function ChannelBadge({ channel }: { channel: ElizaOsImage["channel"] }) {
  return (
    <span className={`badge badge-channel badge-channel-${channel}`}>
      {channel}
    </span>
  );
}

function SpecRow({ item }: { item: SpecItem }) {
  const icon =
    item.status === "pass"
      ? "✅"
      : item.status === "fail"
        ? "❌"
        : item.status === "warn"
          ? "⚠️"
          : "⏳";
  return (
    <li className={`spec-row spec-${item.status}`}>
      <span className="spec-icon">{icon}</span>
      <span className="spec-label">{item.label}</span>
      <span className="spec-detail muted">{item.detail}</span>
    </li>
  );
}

function StepStatusIcon({
  stepId,
  progress,
  planSteps,
}: {
  stepId: InstallerStepId;
  progress: number | undefined;
  planSteps: WritePlan["steps"];
}) {
  const planStep = planSteps.find((s) => s.id === stepId);
  if (progress === 1 || planStep?.status === "complete") return <>✅</>;
  if (progress !== undefined && progress > 0 && progress < 1)
    return <span className="spinner">🔄</span>;
  if (planStep?.status === "blocked") return <>🚫</>;
  return <>⬜</>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InstallerApp({ backend }: InstallerAppProps) {
  // Data
  const [drives, setDrives] = useState<RemovableDrive[]>([]);
  const [images, setImages] = useState<ElizaOsImage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Selections
  const [selectedDriveId, setSelectedDriveId] = useState("");
  const [selectedImageId, setSelectedImageId] = useState("");

  // Wizard state
  const [appStep, setAppStep] = useState<AppStep>("selecting-drive");
  const [specs, setSpecs] = useState<SpecItem[]>([]);
  const [acknowledgeDataLoss, setAcknowledgeDataLoss] = useState(false);
  const [writePlan, setWritePlan] = useState<WritePlan | null>(null);
  const [stepProgress, setStepProgress] = useState<
    Partial<Record<InstallerStepId, number>>
  >({});
  const [writeError, setWriteError] = useState<string | null>(null);

  const cancelledRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Load drives + images
  // ---------------------------------------------------------------------------

  const loadData = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true);
      cancelledRef.current = false;
      try {
        const [nextDrives, nextImages] = await Promise.all([
          backend.listRemovableDrives(),
          backend.listImages(),
        ]);
        if (cancelledRef.current) return;
        setDrives(nextDrives);
        setImages(nextImages);
        if (!isRefresh) {
          // Auto-select first safe drive and first image
          setSelectedDriveId(
            nextDrives.find((d) => d.safety === "safe-removable")?.id ??
              nextDrives[0]?.id ??
              "",
          );
          setSelectedImageId(nextImages[0]?.id ?? "");
        }
        setLoadError(null);
      } catch (err) {
        if (!cancelledRef.current) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelledRef.current) {
          setDataLoaded(true);
          setRefreshing(false);
        }
      }
    },
    [backend],
  );

  useEffect(() => {
    void loadData(false);
    return () => {
      cancelledRef.current = true;
    };
  }, [loadData]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const selectedDrive = drives.find((d) => d.id === selectedDriveId);
  const selectedImage = images.find((i) => i.id === selectedImageId);
  const safeRemovableDrives = drives.filter(
    (d) => d.safety === "safe-removable",
  );

  // ---------------------------------------------------------------------------
  // Specs check builder
  // ---------------------------------------------------------------------------

  function buildSpecs(
    drive: RemovableDrive,
    image: ElizaOsImage,
  ): SpecItem[] {
    const meetsSize = drive.sizeBytes >= image.minUsbSizeBytes;
    const isUsb = drive.bus === "usb";
    const isSafe = drive.safety === "safe-removable";

    return [
      {
        key: "capacity",
        label: "Drive capacity",
        status: meetsSize ? "pass" : "fail",
        detail: `${formatBytes(drive.sizeBytes)} ${meetsSize ? "≥" : "<"} ${formatBytes(image.minUsbSizeBytes)} required`,
      },
      {
        key: "bus",
        label: "Drive type",
        status: isUsb ? "pass" : "warn",
        detail: isUsb
          ? `USB (${drive.bus}) — safe to write`
          : `${drive.bus} — non-USB drive detected`,
      },
      {
        key: "safety",
        label: "Not a system disk",
        status: isSafe ? "pass" : "fail",
        detail: isSafe
          ? `${drive.devicePath} is not a system volume`
          : `${drive.devicePath} is classified as a system disk`,
      },
      {
        key: "checksum",
        label: "SHA-256 verification",
        status: "warn",
        detail: "Will verify before write begins",
      },
      {
        key: "arch",
        label: "Architecture",
        status: "pass",
        detail: `${image.architecture} — compatible with most PCs and modern Macs (via USB boot)`,
      },
    ];
  }

  // ---------------------------------------------------------------------------
  // Navigation handlers
  // ---------------------------------------------------------------------------

  function goToImageSelection() {
    if (!selectedDrive || selectedDrive.safety !== "safe-removable") return;
    setAppStep("selecting-image");
  }

  function goToSpecsCheck() {
    if (!selectedDrive || !selectedImage) return;
    setSpecs(buildSpecs(selectedDrive, selectedImage));
    setAppStep("specs-check");
  }

  function goToConfirm() {
    setAcknowledgeDataLoss(false);
    setAppStep("confirming");
  }

  async function handlePreviewPlan() {
    if (!selectedDrive || !selectedImage) return;
    setWriteError(null);
    try {
      const plan = await backend.createWritePlan({
        driveId: selectedDrive.id,
        imageId: selectedImage.id,
        dryRun: true,
        acknowledgeDataLoss: true,
      });
      setWritePlan(plan);
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleWrite() {
    if (!selectedDrive || !selectedImage || !acknowledgeDataLoss) return;
    setWriteError(null);
    setStepProgress({});
    setAppStep("writing");

    try {
      const plan = await backend.createWritePlan({
        driveId: selectedDrive.id,
        imageId: selectedImage.id,
        dryRun: false,
        acknowledgeDataLoss: true,
      });
      setWritePlan(plan);

      if (backend.executeWritePlan) {
        await backend.executeWritePlan(plan, (step, progress) => {
          setStepProgress((prev) => ({ ...prev, [step]: progress }));
        });
      }
      setAppStep("complete");
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : String(err));
      setAppStep("error");
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const allSpecsPass =
    specs.length > 0 && specs.every((s) => s.status === "pass" || s.status === "warn");

  const overallProgress =
    writePlan && Object.keys(stepProgress).length > 0
      ? Math.round(
          (Object.values(stepProgress).reduce((a, b) => a + (b ?? 0), 0) /
            writePlan.steps.length) *
            100,
        )
      : 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main id="main" className="installer-shell">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="header-band">
        <div>
          <img
            className="brand-logo"
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
            alt="elizaOS"
          />
          <p className="eyebrow">elizaOS media tool</p>
          <h1>USB installer</h1>
        </div>
        {/* Step breadcrumb */}
        <nav className="step-nav" aria-label="Wizard steps">
          {(
            [
              "selecting-drive",
              "selecting-image",
              "specs-check",
              "confirming",
              "writing",
            ] as AppStep[]
          ).map((step, idx) => {
            const labels: Record<string, string> = {
              "selecting-drive": "Drive",
              "selecting-image": "Image",
              "specs-check": "Specs",
              confirming: "Confirm",
              writing: "Write",
            };
            const isActive =
              appStep === step ||
              (appStep === "complete" && step === "writing") ||
              (appStep === "error" && step === "writing");
            const isPast =
              (
                [
                  "selecting-drive",
                  "selecting-image",
                  "specs-check",
                  "confirming",
                  "writing",
                ] as AppStep[]
              ).indexOf(appStep) > idx;
            return (
              <span
                key={step}
                className={`step-crumb ${isActive ? "active" : ""} ${isPast ? "past" : ""}`}
              >
                {labels[step]}
              </span>
            );
          })}
        </nav>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Loading / error state                                               */}
      {/* ------------------------------------------------------------------ */}
      {!dataLoaded && (
        <section className="workspace-single">
          <div className="panel">
            <p className="muted">Scanning system for removable drives...</p>
          </div>
        </section>
      )}

      {dataLoaded && loadError && (
        <section className="workspace-single">
          <div className="panel">
            <p className="error">Failed to load: {loadError}</p>
            <button type="button" onClick={() => void loadData(true)}>
              Retry
            </button>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 1: Drive selection                                             */}
      {/* ------------------------------------------------------------------ */}
      {dataLoaded && !loadError && appStep === "selecting-drive" && (
        <section className="workspace-grid">
          <div className="panel drive-panel">
            <div className="panel-header">
              <h2>Select Target Drive</h2>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={refreshing}
                onClick={() => void loadData(true)}
              >
                {refreshing ? "Scanning..." : "Refresh"}
              </button>
            </div>

            {drives.length === 0 ? (
              <p className="muted">
                No drives detected. Connect a USB drive and click Refresh.
              </p>
            ) : (
              <div className="drive-list" role="radiogroup" aria-label="Target drive">
                {drives.map((drive) => (
                  <label
                    key={drive.id}
                    className={`drive-row ${drive.id === selectedDriveId ? "selected" : ""} ${drive.safety !== "safe-removable" ? "drive-row-blocked" : ""}`}
                  >
                    <input
                      type="radio"
                      name="drive"
                      value={drive.id}
                      checked={drive.id === selectedDriveId}
                      disabled={drive.safety !== "safe-removable"}
                      onChange={() => setSelectedDriveId(drive.id)}
                    />
                    <span className="drive-info">
                      <strong>{drive.name}</strong>
                      <span className="muted">
                        {drive.devicePath} — {formatBytes(drive.sizeBytes)} —{" "}
                        {drive.bus.toUpperCase()}
                      </span>
                    </span>
                    <SafetyBadge safety={drive.safety} />
                  </label>
                ))}
              </div>
            )}

            {safeRemovableDrives.length === 0 && drives.length > 0 && (
              <p className="warn-text">
                No safe removable drives found. Internal and APFS disks are
                blocked for safety. Connect a USB drive.
              </p>
            )}

            <div className="panel-actions">
              <button
                type="button"
                disabled={!selectedDrive || selectedDrive.safety !== "safe-removable"}
                onClick={goToImageSelection}
              >
                Next: Select Image →
              </button>
            </div>
          </div>

          <div className="panel notes-panel">
            <h2>Platform Notes</h2>
            <h3>macOS</h3>
            <ul>
              <li>
                Internal APFS/HFS disks are always blocked — only external USB
                drives are selectable.
              </li>
              <li>
                Writing to the drive requires administrator privileges. A macOS
                password prompt will appear.
              </li>
              <li>
                The drive will be completely erased. Back up any data on the
                target drive first.
              </li>
              <li>
                After writing, you can boot from this drive by holding{" "}
                <kbd>Option</kbd> at startup.
              </li>
            </ul>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 2: Image selection                                             */}
      {/* ------------------------------------------------------------------ */}
      {dataLoaded && !loadError && appStep === "selecting-image" && (
        <section className="workspace-grid">
          <div className="panel image-panel">
            <h2>Select elizaOS Image</h2>

            <div className="image-list" role="radiogroup" aria-label="elizaOS image">
              {images.map((image) => {
                const fits =
                  selectedDrive &&
                  selectedDrive.sizeBytes >= image.minUsbSizeBytes;
                return (
                  <label
                    key={image.id}
                    className={`image-row ${image.id === selectedImageId ? "selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="image"
                      value={image.id}
                      checked={image.id === selectedImageId}
                      onChange={() => setSelectedImageId(image.id)}
                    />
                    <span className="image-info">
                      <span className="image-title">
                        <strong>{image.label}</strong>{" "}
                        <ChannelBadge channel={image.channel} />
                      </span>
                      <span className="muted">
                        {image.architecture} — {formatBytes(image.sizeBytes)} —
                        published{" "}
                        {new Date(image.publishedAt).toLocaleDateString()}
                      </span>
                      <span className="muted">
                        Min drive: {formatBytes(image.minUsbSizeBytes)}
                      </span>
                    </span>
                    <span
                      className={`compat-badge ${fits ? "compat-ok" : "compat-fail"}`}
                    >
                      {fits ? "✅ Compatible" : "❌ Too small"}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="panel-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setAppStep("selecting-drive")}
              >
                ← Back
              </button>
              <button
                type="button"
                disabled={!selectedImage}
                onClick={goToSpecsCheck}
              >
                Next: Specs Check →
              </button>
            </div>
          </div>

          <div className="panel notes-panel">
            <h2>Selected Drive</h2>
            {selectedDrive && (
              <dl className="image-details">
                <div>
                  <dt>Name</dt>
                  <dd>{selectedDrive.name}</dd>
                </div>
                <div>
                  <dt>Device</dt>
                  <dd>{selectedDrive.devicePath}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(selectedDrive.sizeBytes)}</dd>
                </div>
                <div>
                  <dt>Bus</dt>
                  <dd>{selectedDrive.bus.toUpperCase()}</dd>
                </div>
                <div>
                  <dt>Safety</dt>
                  <dd>
                    <SafetyBadge safety={selectedDrive.safety} />
                  </dd>
                </div>
              </dl>
            )}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 3: Specs check                                                 */}
      {/* ------------------------------------------------------------------ */}
      {dataLoaded && !loadError && appStep === "specs-check" && selectedDrive && selectedImage && (
        <section className="workspace-grid">
          <div className="panel specs-panel">
            <h2>Specs Check</h2>
            <p className="muted">
              Checking compatibility of{" "}
              <strong>{selectedDrive.name}</strong> ({selectedDrive.devicePath})
              → <strong>{selectedImage.label}</strong>{" "}
              <ChannelBadge channel={selectedImage.channel} />
            </p>

            <ul className="spec-list">
              {specs.map((item) => (
                <SpecRow key={item.key} item={item} />
              ))}
            </ul>

            {!allSpecsPass && (
              <p className="error">
                Some checks failed. Resolve the issues above before writing.
              </p>
            )}

            <div className="panel-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setAppStep("selecting-image")}
              >
                ← Back
              </button>
              <button
                type="button"
                disabled={!allSpecsPass}
                onClick={goToConfirm}
              >
                Next: Confirm & Write →
              </button>
            </div>
          </div>

          <div className="panel notes-panel">
            <h2>Image Details</h2>
            <dl className="image-details">
              <div>
                <dt>Image</dt>
                <dd>{selectedImage.label}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{selectedImage.version}</dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>
                  <ChannelBadge channel={selectedImage.channel} />
                </dd>
              </div>
              <div>
                <dt>Architecture</dt>
                <dd>{selectedImage.architecture}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(selectedImage.sizeBytes)}</dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>{new Date(selectedImage.publishedAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd className="hash-value">{selectedImage.checksumSha256}</dd>
              </div>
            </dl>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 4: Confirm & Write                                             */}
      {/* ------------------------------------------------------------------ */}
      {dataLoaded && !loadError && appStep === "confirming" && selectedDrive && selectedImage && (
        <section className="workspace-grid">
          <div className="panel confirm-panel">
            <h2>Confirm Write</h2>

            <div className="erase-warning">
              <p>
                This will <strong>completely erase</strong>{" "}
                <strong>
                  {selectedDrive.name} ({selectedDrive.devicePath},{" "}
                  {formatBytes(selectedDrive.sizeBytes)})
                </strong>{" "}
                and write{" "}
                <strong>
                  {selectedImage.label} {selectedImage.version}
                </strong>
                .
              </p>
              <p className="muted">
                This cannot be undone. All data on the drive will be
                permanently lost.
              </p>
            </div>

            <label className="ack-row">
              <input
                type="checkbox"
                checked={acknowledgeDataLoss}
                onChange={(e) => setAcknowledgeDataLoss(e.target.checked)}
              />
              <span>
                I understand the drive will be <strong>completely erased</strong>.
              </span>
            </label>

            {writePlan ? (
              <div className="preview-plan">
                <h3>Write Plan Preview</h3>
                <ol className="step-list">
                  {writePlan.steps.map((step) => (
                    <li key={step.id} className={step.status}>
                      <strong>{step.label}</strong>
                      <span>{step.detail}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}

            <div className="panel-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setAppStep("specs-check")}
              >
                ← Back
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void handlePreviewPlan()}
              >
                Preview Plan
              </button>
              {backend.executeWritePlan ? (
                <button
                  type="button"
                  className="btn-danger"
                  disabled={!acknowledgeDataLoss}
                  title={
                    !acknowledgeDataLoss
                      ? "Check the acknowledgement box first"
                      : undefined
                  }
                  onClick={() => void handleWrite()}
                >
                  Write to Drive
                </button>
              ) : (
                <span className="muted">
                  Live write not available in this environment.
                </span>
              )}
            </div>

            {writeError ? <p className="error">{writeError}</p> : null}
          </div>

          <div className="panel notes-panel">
            <h2>What Happens Next</h2>
            <ol className="walkthrough-list">
              <li>The image URL is resolved and downloaded (if not cached).</li>
              <li>SHA-256 checksum is verified.</li>
              <li>
                macOS will prompt for your administrator password to write the
                image.
              </li>
              <li>
                <code>dd</code> writes the image to{" "}
                <code>{selectedDrive.devicePath}</code> via raw disk access.
              </li>
              <li>The drive is verified and ejected.</li>
            </ol>
            <p className="muted">
              Do not unplug the drive during writing. This may take several
              minutes depending on image size and drive speed.
            </p>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 5: Writing                                                     */}
      {/* ------------------------------------------------------------------ */}
      {appStep === "writing" && writePlan && (
        <section className="workspace-grid">
          <div className="panel writing-panel">
            <h2>Writing elizaOS to Drive</h2>
            <p className="muted">
              Writing{" "}
              <strong>
                {writePlan.image.label} {writePlan.image.version}
              </strong>{" "}
              to{" "}
              <strong>
                {writePlan.drive.name} ({writePlan.drive.devicePath})
              </strong>
              . Do not unplug the drive.
            </p>

            <div
              className="progress-bar"
              role="progressbar"
              aria-valuenow={overallProgress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="progress-fill"
                style={{ width: `${overallProgress}%` }}
              />
              <span className="progress-label">{overallProgress}%</span>
            </div>

            <ol className="step-list writing-steps">
              {writePlan.steps.map((step) => {
                const progress = stepProgress[step.id];
                const isRunning =
                  progress !== undefined && progress > 0 && progress < 1;
                const isDone = progress === 1;
                return (
                  <li
                    key={step.id}
                    className={
                      isDone
                        ? "complete"
                        : isRunning
                          ? "running"
                          : step.status
                    }
                  >
                    <span className="step-icon">
                      <StepStatusIcon
                        stepId={step.id}
                        progress={progress}
                        planSteps={writePlan.steps}
                      />
                    </span>
                    <span>
                      <strong>{step.label}</strong>
                      <span className="muted">{step.detail}</span>
                      {isRunning && (
                        <div
                          className="progress-bar progress-bar-sm"
                          role="progressbar"
                          aria-valuenow={Math.round((progress ?? 0) * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className="progress-fill"
                            style={{
                              width: `${Math.round((progress ?? 0) * 100)}%`,
                            }}
                          />
                          <span className="progress-label">
                            {Math.round((progress ?? 0) * 100)}%
                          </span>
                        </div>
                      )}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          <div className="panel notes-panel">
            <h2>In Progress</h2>
            <p>
              Writing to a USB SSD typically takes 5–20 minutes depending on
              the image size and drive speed.
            </p>
            <p className="muted">
              A macOS password prompt may have appeared — check your Dock if
              the UI appears frozen.
            </p>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Complete                                                            */}
      {/* ------------------------------------------------------------------ */}
      {appStep === "complete" && writePlan && (
        <section className="workspace-single">
          <div className="panel complete-panel">
            <h2>Write Complete ✅</h2>
            <p>
              <strong>elizaOS</strong> has been written to your{" "}
              <strong>{writePlan.drive.name}</strong>. The drive has been
              ejected and is ready to boot from.
            </p>
            <p className="muted">
              To boot: connect the drive to a PC and select it as the boot
              device (usually by pressing F12, F10, or Del at startup). On a
              Mac, hold <kbd>Option</kbd> at startup.
            </p>
            <button
              type="button"
              onClick={() => {
                setAppStep("selecting-drive");
                setWritePlan(null);
                setStepProgress({});
                setAcknowledgeDataLoss(false);
                void loadData(true);
              }}
            >
              Write Another Drive
            </button>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Error                                                               */}
      {/* ------------------------------------------------------------------ */}
      {appStep === "error" && (
        <section className="workspace-single">
          <div className="panel error-panel">
            <h2>Write Failed ❌</h2>
            {writeError && <p className="error">{writeError}</p>}
            <p className="muted">
              The drive may be in an incomplete state. Do not use it until the
              write succeeds.
            </p>
            <div className="panel-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setAppStep("confirming")}
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppStep("selecting-drive");
                  setWritePlan(null);
                  setStepProgress({});
                  setAcknowledgeDataLoss(false);
                }}
              >
                Start Over
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Footer                                                              */}
      {/* ------------------------------------------------------------------ */}
      <section className="footer-band">
        <img
          className="brand-logo"
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
          alt="elizaOS"
        />
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
