import { Download, ExternalLink, HardDrive, Info } from "lucide-react";

export type OsArtifact = {
  id: string;
  label: string;
  description: string;
  platform: "linux" | "android" | "macos" | "windows" | "cross-platform";
  kind: "iso" | "deb" | "ova" | "apk" | "desktop-app";
  channel: "stable" | "beta" | "nightly";
  version: string;
  downloadUrl: string | null;
  checksumUrl: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  releaseNotesUrl: string | null;
  requiresHardware?: string;
};

interface OsDownloadsProps {
  artifacts: OsArtifact[];
}

type CategoryKey = "linux" | "android" | "tools";

interface Category {
  key: CategoryKey;
  label: string;
  description: string;
  filter: (artifact: OsArtifact) => boolean;
}

const CATEGORIES: Category[] = [
  {
    key: "linux",
    label: "Linux Desktop",
    description: "Bootable images, package manager installs, and VM bundles.",
    filter: (a) =>
      a.platform === "linux" || a.platform === "cross-platform"
        ? ["iso", "deb", "ova"].includes(a.kind)
        : false,
  },
  {
    key: "android",
    label: "Android",
    description: "Full OS replacement or sideloadable APK.",
    filter: (a) => a.platform === "android" && ["apk"].includes(a.kind),
  },
  {
    key: "tools",
    label: "Install Tools",
    description:
      "Desktop apps for creating elizaOS USB drives and flashing Android devices.",
    filter: (a) => a.kind === "desktop-app",
  },
];

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"] as const;
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function kindLabel(kind: OsArtifact["kind"]): string {
  switch (kind) {
    case "iso":
      return "ISO";
    case "deb":
      return "DEB";
    case "ova":
      return "OVA";
    case "apk":
      return "APK";
    case "desktop-app":
      return "App";
  }
}

function platformLabel(platform: OsArtifact["platform"]): string {
  switch (platform) {
    case "linux":
      return "Linux";
    case "android":
      return "Android";
    case "macos":
      return "macOS";
    case "windows":
      return "Windows";
    case "cross-platform":
      return "Cross-platform";
  }
}

function ArtifactCard({ artifact }: { artifact: OsArtifact }) {
  const sizeLabel = formatBytes(artifact.sizeBytes);
  const isAvailable = artifact.downloadUrl !== null;

  return (
    <div className="artifact-card" data-kind={artifact.kind} data-available={isAvailable}>
      <div className="artifact-card-head">
        <div className="artifact-badges">
          <span className="artifact-badge artifact-badge-kind">
            {kindLabel(artifact.kind)}
          </span>
          <span className="artifact-badge artifact-badge-platform">
            {platformLabel(artifact.platform)}
          </span>
          {!isAvailable && (
            <span className="artifact-badge artifact-badge-soon">
              Coming soon
            </span>
          )}
        </div>
        <h3 className="artifact-label">{artifact.label}</h3>
        <p className="artifact-description">{artifact.description}</p>
      </div>

      {artifact.requiresHardware && (
        <div className="artifact-prereq">
          <HardDrive className="artifact-prereq-icon" />
          <span>Requires: {artifact.requiresHardware}</span>
        </div>
      )}

      <div className="artifact-card-foot">
        {sizeLabel && (
          <span className="artifact-size">{sizeLabel}</span>
        )}

        <div className="artifact-actions">
          {artifact.checksumUrl && (
            <a
              href={artifact.checksumUrl}
              className="artifact-link"
              aria-label="Checksum file"
            >
              <Info className="icon" />
              Checksum
            </a>
          )}
          {artifact.releaseNotesUrl && (
            <a
              href={artifact.releaseNotesUrl}
              className="artifact-link"
              aria-label="Release notes"
            >
              <ExternalLink className="icon" />
              Notes
            </a>
          )}
          <a
            href={artifact.downloadUrl ?? undefined}
            className={
              isAvailable
                ? "button artifact-download-button"
                : "button artifact-download-button artifact-download-button-disabled"
            }
            aria-disabled={!isAvailable}
            onClick={isAvailable ? undefined : (e) => e.preventDefault()}
            download={isAvailable || undefined}
          >
            <Download className="icon" />
            {isAvailable ? "Download" : "Coming soon"}
          </a>
        </div>
      </div>
    </div>
  );
}

function CategorySection({
  category,
  artifacts,
}: {
  category: Category;
  artifacts: OsArtifact[];
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="artifact-category">
      <div className="artifact-category-head">
        <h2>{category.label}</h2>
        <p className="artifact-category-desc">{category.description}</p>
      </div>
      <div className="artifact-grid">
        {artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} />
        ))}
      </div>
    </div>
  );
}

export function OsDownloads({ artifacts }: OsDownloadsProps) {
  return (
    <section id="downloads" className="band band-black os-downloads">
      <div className="band-inner">
        <div className="section-head">
          <h2>Downloads.</h2>
          <p className="section-lede">
            elizaOS runs on Linux PCs, Android devices, and virtual machines.
            Pick your target.
          </p>
        </div>

        {CATEGORIES.map((category) => {
          const filtered = artifacts.filter(category.filter);
          return (
            <CategorySection
              key={category.key}
              category={category}
              artifacts={filtered}
            />
          );
        })}

        <div className="artifact-channel-note">
          <p>
            <strong>Beta</strong> — feature-complete, may have rough edges.
            Checksums and signatures are published alongside each build.
          </p>
        </div>
      </div>
    </section>
  );
}
