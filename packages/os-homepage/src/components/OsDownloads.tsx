import { Download, ExternalLink, HardDrive, Info } from "lucide-react";
import { useT } from "../providers/I18nProvider";

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
  labelKey: string;
  labelDefault: string;
  descriptionKey: string;
  descriptionDefault: string;
  filter: (artifact: OsArtifact) => boolean;
}

const CATEGORIES: Category[] = [
  {
    key: "linux",
    labelKey: "homepage_os.downloads.categoryLinuxLabel",
    labelDefault: "Linux Desktop",
    descriptionKey: "homepage_os.downloads.categoryLinuxDescription",
    descriptionDefault:
      "Bootable images, package manager installs, and VM bundles.",
    filter: (a) =>
      a.platform === "linux" || a.platform === "cross-platform"
        ? ["iso", "deb", "ova"].includes(a.kind)
        : false,
  },
  {
    key: "android",
    labelKey: "homepage_os.downloads.categoryAndroidLabel",
    labelDefault: "Android",
    descriptionKey: "homepage_os.downloads.categoryAndroidDescription",
    descriptionDefault: "Full OS replacement or sideloadable APK.",
    filter: (a) => a.platform === "android" && ["apk"].includes(a.kind),
  },
  {
    key: "tools",
    labelKey: "homepage_os.downloads.categoryToolsLabel",
    labelDefault: "Install Tools",
    descriptionKey: "homepage_os.downloads.categoryToolsDescription",
    descriptionDefault: "Make an elizaOS USB. Flash an Android device.",
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
  const t = useT();
  const sizeLabel = formatBytes(artifact.sizeBytes);
  const isAvailable = artifact.downloadUrl !== null;

  return (
    <div
      className="artifact-card"
      data-kind={artifact.kind}
      data-available={isAvailable}
    >
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
              {t("homepage_os.downloads.comingSoonBadge", {
                defaultValue: "Coming soon",
              })}
            </span>
          )}
        </div>
        <h3 className="artifact-label">{artifact.label}</h3>
        <p className="artifact-description">{artifact.description}</p>
      </div>

      {artifact.requiresHardware && (
        <div className="artifact-prereq">
          <HardDrive className="artifact-prereq-icon" />
          <span>
            {t("homepage_os.downloads.requires", {
              defaultValue: "Requires: {{hardware}}",
              hardware: artifact.requiresHardware,
            })}
          </span>
        </div>
      )}

      <div className="artifact-card-foot">
        {sizeLabel && <span className="artifact-size">{sizeLabel}</span>}

        <div className="artifact-actions">
          {artifact.checksumUrl && (
            <a
              href={artifact.checksumUrl}
              className="artifact-link"
              aria-label={t("homepage_os.downloads.checksumAria", {
                defaultValue: "Checksum file",
              })}
            >
              <Info className="icon" />
              {t("homepage_os.downloads.checksum", { defaultValue: "Checksum" })}
            </a>
          )}
          {artifact.releaseNotesUrl && (
            <a
              href={artifact.releaseNotesUrl}
              className="artifact-link"
              aria-label={t("homepage_os.downloads.releaseNotesAria", {
                defaultValue: "Release notes",
              })}
            >
              <ExternalLink className="icon" />
              {t("homepage_os.downloads.notes", { defaultValue: "Notes" })}
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
            {isAvailable
              ? t("homepage_os.downloads.download", { defaultValue: "Download" })
              : t("homepage_os.downloads.comingSoon", {
                  defaultValue: "Coming soon",
                })}
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
  const t = useT();
  if (artifacts.length === 0) return null;
  return (
    <div className="artifact-category">
      <div className="artifact-category-head">
        <h2>{t(category.labelKey, { defaultValue: category.labelDefault })}</h2>
        <p className="artifact-category-desc">
          {t(category.descriptionKey, {
            defaultValue: category.descriptionDefault,
          })}
        </p>
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
  const t = useT();
  return (
    <section id="downloads" className="band band-black os-downloads">
      <div className="band-inner">
        <div className="section-head">
          <h2>{t("homepage_os.downloads.title", { defaultValue: "Downloads." })}</h2>
          <p className="section-lede">
            {t("homepage_os.downloads.lede", {
              defaultValue:
                "Linux PCs, Android, and virtual machines. Pick your target.",
            })}
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
            <strong>
              {t("homepage_os.downloads.channelNoteBeta", {
                defaultValue: "Beta",
              })}
            </strong>
            {t("homepage_os.downloads.channelNoteBody", {
              defaultValue:
                " — feature-complete, rough edges expected. Checksums and signatures published with each build.",
            })}
          </p>
        </div>
      </div>
    </section>
  );
}
