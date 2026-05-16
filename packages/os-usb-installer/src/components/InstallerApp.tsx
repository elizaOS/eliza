import { useEffect, useMemo, useState } from "react";
import { detectPlatformId, PLATFORM_NOTES } from "../backend/platform-notes";
import type {
  ElizaOsImage,
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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [nextDrives, nextImages] = await Promise.all([
          backend.listRemovableDrives(),
          backend.listImages(),
        ]);
        if (cancelled) {
          return;
        }

        setDrives(nextDrives);
        setImages(nextImages);
        setSelectedDriveId(
          nextDrives.find((drive) => drive.safety === "safe-removable")?.id ??
            nextDrives[0]?.id ??
            "",
        );
        setSelectedImageId(nextImages[0]?.id ?? "");
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
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

  async function prepareDryRun() {
    setError(null);
    setWritePlan(null);

    try {
      const plan = await backend.createWritePlan({
        driveId: selectedDriveId,
        imageId: selectedImageId,
        dryRun: true,
        acknowledgeDataLoss,
      });
      setWritePlan(plan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <main className="installer-shell">
      <section className="header-band">
        <div>
          <p className="eyebrow">elizaOS media tool</p>
          <h1>USB Installer</h1>
        </div>
        <span className="status-pill">Dry-run only</span>
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
            <li>Run the dry-run plan to confirm every destructive gate.</li>
          </ol>
          <label className="ack-row">
            <input
              type="checkbox"
              checked={acknowledgeDataLoss}
              onChange={(event) => setAcknowledgeDataLoss(event.target.checked)}
            />
            <span>I understand the selected drive would be erased.</span>
          </label>
          <button
            type="button"
            disabled={!selectedDrive || !selectedImage}
            onClick={() => void prepareDryRun()}
          >
            Prepare dry-run
          </button>
          {error ? <p className="error">{error}</p> : null}
          {selectedDrive && selectedImage ? (
            <p className="muted">
              This package can only prepare a dry-run plan. It refuses
              non-dry-run requests and does not implement raw disk writes.
            </p>
          ) : null}
          {writePlan ? (
            <ol className="step-list">
              {writePlan.steps.map((step) => (
                <li key={step.id} className={step.status}>
                  <strong>{step.label}</strong>
                  <span>{step.detail}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>

        <div className="panel notes-panel">
          <h2>Platform Notes</h2>
          <p className="muted">
            Privileged disk writes are intentionally not implemented in this
            scaffold.
          </p>
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
    </main>
  );
}
