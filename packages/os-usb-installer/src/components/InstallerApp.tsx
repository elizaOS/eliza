import { useEffect, useMemo, useRef, useState } from "react";
import { detectPlatformId, PLATFORM_NOTES } from "../backend/platform-notes";
import type {
  ElizaOsImage,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
} from "../backend/types";

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

type WriteMode = "preview" | "real";

interface StepProgress {
  step: InstallerStepId;
  progress: number;
}

interface InstallerAppProps {
  backend: UsbInstallerBackend;
}

export function InstallerApp({ backend }: InstallerAppProps) {
  const [drives, setDrives] = useState<RemovableDrive[]>([]);
  const [images, setImages] = useState<ElizaOsImage[]>([]);
  const [selectedDriveId, setSelectedDriveId] = useState("");
  const [selectedImageId, setSelectedImageId] = useState("");
  const [acknowledgeDataLoss, setAcknowledgeDataLoss] = useState(false);
  const [writePlan, setWritePlan] = useState<WritePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [stepProgress, setStepProgress] = useState<Partial<Record<InstallerStepId, number>>>({});
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [pendingWriteMode, setPendingWriteMode] = useState<WriteMode | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function load() {
      try {
        const [nextDrives, nextImages] = await Promise.all([
          backend.listRemovableDrives(),
          backend.listImages(),
        ]);
        if (cancelledRef.current) return;

        setDrives(nextDrives);
        setImages(nextImages);
        setSelectedDriveId(
          nextDrives.find((drive) => drive.safety === "safe-removable")?.id ??
            nextDrives[0]?.id ??
            "",
        );
        setSelectedImageId(nextImages[0]?.id ?? "");
      } catch (cause) {
        if (!cancelledRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelledRef.current) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelledRef.current = true;
    };
  }, [backend]);

  const selectedDrive = useMemo(
    () => drives.find((drive) => drive.id === selectedDriveId),
    [drives, selectedDriveId],
  );
  const selectedImage = useMemo(
    () => images.find((image) => image.id === selectedImageId),
    [images, selectedImageId],
  );
  const platformNotes = PLATFORM_NOTES.find(
    (note) => note.platform === detectPlatformId(),
  );

  const supportsRealWrite = Boolean(backend.executeWritePlan);

  async function handleAction(mode: WriteMode) {
    if (mode === "real") {
      setPendingWriteMode("real");
      setShowConfirmModal(true);
      return;
    }
    await runWrite("preview");
  }

  async function confirmRealWrite() {
    setShowConfirmModal(false);
    if (pendingWriteMode === "real") {
      await runWrite("real");
    }
    setPendingWriteMode(null);
  }

  function cancelRealWrite() {
    setShowConfirmModal(false);
    setPendingWriteMode(null);
  }

  async function runWrite(mode: WriteMode) {
    setError(null);
    setWritePlan(null);
    setStepProgress({});

    const isDryRun = mode === "preview";

    try {
      const plan = await backend.createWritePlan({
        driveId: selectedDriveId,
        imageId: selectedImageId,
        dryRun: isDryRun,
        acknowledgeDataLoss,
      });
      setWritePlan(plan);

      if (!isDryRun && backend.executeWritePlan) {
        setExecuting(true);
        await backend.executeWritePlan(plan, (step, progress) => {
          setStepProgress((prev) => ({ ...prev, [step]: progress }));
        });
        setExecuting(false);
      }
    } catch (cause) {
      setExecuting(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const canWrite =
    Boolean(selectedDrive) && Boolean(selectedImage) && !executing;
  const canRealWrite = canWrite && acknowledgeDataLoss && supportsRealWrite;

  return (
    <main className="installer-shell">
      {showConfirmModal && selectedDrive && selectedImage ? (
        <div className="modal-overlay">
          <div className="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <h2 id="modal-title">Confirm destructive write</h2>
            <p>
              <strong>All data on {selectedDrive.name} ({selectedDrive.devicePath}) will be permanently erased.</strong>
            </p>
            <p>
              The image <strong>{selectedImage.label} {selectedImage.version}</strong> ({formatBytes(selectedImage.sizeBytes)}) will be written to this drive.
            </p>
            <p className="muted">This cannot be undone. Make sure you have selected the correct drive.</p>
            <div className="modal-actions">
              <button type="button" className="btn-danger" onClick={() => void confirmRealWrite()}>
                Yes, erase and write
              </button>
              <button type="button" onClick={cancelRealWrite}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="header-band">
        <div>
          <img
            className="brand-logo"
            src="/brand/logos/elizaOS_text_white.svg"
            alt="elizaOS"
          />
          <p className="eyebrow">elizaOS media tool</p>
          <h1>USB installer</h1>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel">
          <h2>Target Drive</h2>
          {loading ? (
            <p className="muted">Scanning removable drives...</p>
          ) : (
            <div
              className="drive-list"
              role="radiogroup"
              aria-label="Target drive"
            >
              {drives.map((drive) => (
                <label
                  className={`drive-row ${
                    drive.id === selectedDriveId ? "selected" : ""
                  }`}
                  key={drive.id}
                >
                  <input
                    type="radio"
                    name="drive"
                    value={drive.id}
                    checked={drive.id === selectedDriveId}
                    onChange={() => setSelectedDriveId(drive.id)}
                  />
                  <span>
                    <strong>{drive.name}</strong>
                    <span className="muted">
                      {drive.devicePath} - {formatBytes(drive.sizeBytes)} -{" "}
                      {drive.bus}
                    </span>
                  </span>
                  <span className={`safety ${drive.safety}`}>
                    {drive.safety}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Image</h2>
          <label className="field">
            <span>Release</span>
            <select
              value={selectedImageId}
              onChange={(event) => setSelectedImageId(event.target.value)}
            >
              {images.map((image) => (
                <option key={image.id} value={image.id}>
                  {image.label} {image.version}
                </option>
              ))}
            </select>
          </label>

          {selectedImage ? (
            <dl className="image-details">
              <div>
                <dt>Channel</dt>
                <dd>{selectedImage.channel}</dd>
              </div>
              <div>
                <dt>Architecture</dt>
                <dd>{selectedImage.architecture}</dd>
              </div>
              <div>
                <dt>Build</dt>
                <dd>{selectedImage.buildId}</dd>
              </div>
              <div>
                <dt>Published</dt>
                <dd>{new Date(selectedImage.publishedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>URL</dt>
                <dd>{selectedImage.url}</dd>
              </div>
              <div>
                <dt>SHA-256</dt>
                <dd>{selectedImage.checksumSha256}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(selectedImage.sizeBytes)}</dd>
              </div>
              <div>
                <dt>Minimum USB</dt>
                <dd>{formatBytes(selectedImage.minUsbSizeBytes)}</dd>
              </div>
            </dl>
          ) : null}
        </div>

        <div className="panel action-panel">
          <h2>Write Flow</h2>
          <ol className="walkthrough-list">
            <li>Pick a trusted elizaOS release and review its manifest.</li>
            <li>Select removable media that meets the minimum USB size.</li>
            <li>Preview the plan or write directly to the drive.</li>
          </ol>
          <label className="ack-row">
            <input
              type="checkbox"
              checked={acknowledgeDataLoss}
              onChange={(event) => setAcknowledgeDataLoss(event.target.checked)}
            />
            <span>I understand the selected drive would be erased.</span>
          </label>

          <div className="action-buttons">
            <button
              type="button"
              disabled={!canWrite}
              onClick={() => void handleAction("preview")}
            >
              Preview plan
            </button>
            {supportsRealWrite ? (
              <button
                type="button"
                className="btn-danger"
                disabled={!canRealWrite}
                title={
                  !acknowledgeDataLoss
                    ? "Check the acknowledgement box first"
                    : undefined
                }
                onClick={() => void handleAction("real")}
              >
                {executing ? "Writing..." : "Write to drive"}
              </button>
            ) : null}
          </div>

          {error ? <p className="error">{error}</p> : null}

          {writePlan ? (
            <ol className="step-list">
              {writePlan.steps.map((step) => {
                const progress = stepProgress[step.id];
                const isRunning =
                  progress !== undefined && progress > 0 && progress < 1;
                const isDone = progress === 1;
                return (
                  <li
                    key={step.id}
                    className={isDone ? "complete" : isRunning ? "running" : step.status}
                  >
                    <strong>{step.label}</strong>
                    <span>{step.detail}</span>
                    {isRunning ? (
                      <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                        <div
                          className="progress-fill"
                          style={{ width: `${Math.round(progress * 100)}%` }}
                        />
                        <span className="progress-label">{Math.round(progress * 100)}%</span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>

        <div className="panel notes-panel">
          <h2>Platform Notes</h2>
          {platformNotes ? (
            <>
              <h3>{platformNotes.title}</h3>
              <ul>
                {platformNotes.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">
              No platform-specific notes for this runtime.
            </p>
          )}
        </div>
      </section>
      <section className="footer-band">
        <img
          className="brand-logo"
          src="/brand/logos/elizaOS_text_white.svg"
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
