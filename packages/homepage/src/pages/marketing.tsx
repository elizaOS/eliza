/**
 * Public homepage download and launch surface for elizaOS apps.
 */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  ArrowRight,
  BadgeCheck,
  Cloud,
  Download,
  ExternalLink,
  MonitorDown,
  Package,
  Smartphone,
  Store,
} from "lucide-react";
import { releaseData } from "@/generated/release-data";
import { useT } from "@/providers/I18nProvider";

const cloudUrl = `${EXTERNAL_URLS.cloud}/login?intent=launch`;
const webAppUrl = EXTERNAL_URLS.app;
const osUrl = EXTERNAL_URLS.os;
const releaseFallbackUrl = `${EXTERNAL_URLS.github}/releases`;

const primaryDownloadIds = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "linux-deb",
  "android-apk",
] as const;

type DownloadId = (typeof primaryDownloadIds)[number];

const platformIcon: Record<DownloadId, typeof Package> = {
  "macos-arm64": MonitorDown,
  "macos-x64": MonitorDown,
  "windows-x64": MonitorDown,
  "linux-x64": Package,
  "linux-deb": Package,
  "android-apk": Smartphone,
};

const FALLBACK_LABEL_KEYS: Record<DownloadId, string> = {
  "macos-arm64": "homepage_eliza.marketing.fallbackMacosArm64",
  "macos-x64": "homepage_eliza.marketing.fallbackMacosX64",
  "windows-x64": "homepage_eliza.marketing.fallbackWindowsX64",
  "linux-x64": "homepage_eliza.marketing.fallbackLinuxX64",
  "linux-deb": "homepage_eliza.marketing.fallbackLinuxDeb",
  "android-apk": "homepage_eliza.marketing.fallbackAndroidApk",
};

const FALLBACK_LABEL_DEFAULTS: Record<DownloadId, string> = {
  "macos-arm64": "macOS (Apple Silicon)",
  "macos-x64": "macOS (Intel)",
  "windows-x64": "Windows",
  "linux-x64": "Linux",
  "linux-deb": "Ubuntu / Debian",
  "android-apk": "Android APK",
};

const PLATFORM_DESCRIPTION_KEYS: Record<DownloadId, string> = {
  "macos-arm64": "homepage_eliza.marketing.descMacosArm64",
  "macos-x64": "homepage_eliza.marketing.descMacosX64",
  "windows-x64": "homepage_eliza.marketing.descWindowsX64",
  "linux-x64": "homepage_eliza.marketing.descLinuxX64",
  "linux-deb": "homepage_eliza.marketing.descLinuxDeb",
  "android-apk": "homepage_eliza.marketing.descAndroidApk",
};

const PLATFORM_DESCRIPTION_DEFAULTS: Record<DownloadId, string> = {
  "macos-arm64": "For M1, M2, M3, and newer Apple Silicon Macs.",
  "macos-x64": "For Intel Macs.",
  "windows-x64": "For 64-bit Windows PCs.",
  "linux-x64": "For 64-bit Linux desktops.",
  "linux-deb": "Ubuntu, Debian, Pop_OS, and derivatives — apt-installable.",
  "android-apk": "Direct APK sideload while Play Store review is pending.",
};

export default function MarketingPage() {
  const t = useT();
  const stableDownloads = releaseData.release.downloads;
  const canaryDownloads = releaseData.canaryRelease?.downloads ?? [];
  const effectiveDownloads =
    stableDownloads.length > 0 ? stableDownloads : canaryDownloads;
  const downloads = primaryDownloadIds.map((id) => {
    const releaseDownload = effectiveDownloads.find(
      (download) => download.id === id,
    );
    const Icon = platformIcon[id];

    return {
      id,
      label:
        releaseDownload?.label ??
        t(FALLBACK_LABEL_KEYS[id], {
          defaultValue: FALLBACK_LABEL_DEFAULTS[id],
        }),
      href: releaseDownload?.url ?? releaseFallbackUrl,
      detail: releaseDownload
        ? t("homepage_eliza.marketing.releaseDetail", {
            defaultValue: "{{note}} · {{sizeLabel}}",
            note: releaseDownload.note,
            sizeLabel: releaseDownload.sizeLabel,
          })
        : t("homepage_eliza.marketing.releaseFallbackDetail", {
            defaultValue: "Release page",
          }),
      meta: releaseDownload
        ? t("homepage_eliza.marketing.releaseFromMeta", {
            defaultValue: "From {{tag}}",
            tag: releaseDownload.releaseTagName,
          })
        : t("homepage_eliza.marketing.releaseFallbackMeta", {
            defaultValue: "Opens release page",
          }),
      fileName:
        releaseDownload?.fileName ??
        t("homepage_eliza.marketing.releaseFallbackFile", {
          defaultValue: "Latest release",
        }),
      description: t(PLATFORM_DESCRIPTION_KEYS[id], {
        defaultValue: PLATFORM_DESCRIPTION_DEFAULTS[id],
      }),
      icon: Icon,
    };
  });

  return (
    <div className="theme-app app-shell">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[var(--brand-orange)]"
      >
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <header className="app-header">
        <a
          href="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
          className="app-brand"
        >
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
            draggable={false}
            className="app-brand-mark"
          />
        </a>
        <nav
          className="app-nav"
          aria-label={t("homepage_eliza.marketing.navProducts", {
            defaultValue: "Eliza products",
          })}
        >
          <a href={webAppUrl}>
            {t("homepage_eliza.marketing.navWebApp", {
              defaultValue: "Web app",
            })}
          </a>
          <a href="#download">
            {t("homepage_eliza.marketing.navDownloads", {
              defaultValue: "Downloads",
            })}
          </a>
          <a href={cloudUrl}>
            {t("homepage_eliza.marketing.navCloud", { defaultValue: "Cloud" })}
          </a>
          <a href={osUrl}>
            {t("homepage_eliza.marketing.navOs", { defaultValue: "OS" })}
          </a>
          <a href="#download" className="app-nav-download">
            {t("homepage_eliza.marketing.navDownload", {
              defaultValue: "Download",
            })}
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="brand-section brand-section--cloud app-hero">
          <div className="app-cloud-scrim" />
          <div className="app-band-inner app-hero-grid app-hero-copy--cloud">
            <div className="app-hero-copy">
              <p className="app-kicker">
                {t("homepage_eliza.marketing.heroKicker", {
                  defaultValue: "Eliza App",
                })}
              </p>
              <h1 className="app-display">
                {t("homepage_eliza.marketing.heroTitle", {
                  defaultValue: "Your Eliza, everywhere.",
                })}
              </h1>
              <p className="app-lede">
                {t("homepage_eliza.marketing.heroLede", {
                  defaultValue:
                    "Download the desktop and mobile app, connect one agent across your devices, and keep Cloud and elizaOS one click away.",
                })}
              </p>
              <div className="app-cta-row">
                <a href={webAppUrl} className="app-cta app-cta--black">
                  <ExternalLink className="app-icon" aria-hidden="true" />
                  {t("homepage_eliza.marketing.ctaOpenWebApp", {
                    defaultValue: "Open web app",
                  })}
                </a>
                <a href="#download" className="app-cta app-cta--glass">
                  <Download className="app-icon" aria-hidden="true" />
                  {t("homepage_eliza.marketing.ctaDownload", {
                    defaultValue: "Download the app",
                  })}
                </a>
                <a href={cloudUrl} className="app-cta app-cta--glass">
                  <Cloud className="app-icon" aria-hidden="true" />
                  {t("homepage_eliza.marketing.ctaTryCloud", {
                    defaultValue: "Try Eliza Cloud",
                  })}
                </a>
                <a href={osUrl} className="app-cta app-cta--ghost">
                  {t("homepage_eliza.marketing.ctaInstallOs", {
                    defaultValue: "Install elizaOS",
                  })}
                  <ArrowRight className="app-icon" aria-hidden="true" />
                </a>
              </div>
            </div>
            <section
              className="app-release-panel"
              aria-label={t("homepage_eliza.marketing.releaseLabel", {
                defaultValue: "Current release",
              })}
            >
              <div>
                <span className="app-pill">
                  {t("homepage_eliza.marketing.releasePill", {
                    defaultValue: "Latest release",
                  })}
                </span>
                <h2>{releaseData.release.tagName}</h2>
                <p>{releaseData.release.publishedAtLabel}</p>
              </div>
              <a href={releaseData.release.url} className="app-release-link">
                {t("homepage_eliza.marketing.releaseNotes", {
                  defaultValue: "Release notes",
                })}
                <ExternalLink className="app-icon" aria-hidden="true" />
              </a>
            </section>
          </div>
        </section>

        <section id="download" className="brand-section brand-section--white">
          <div className="app-band-inner app-download-band">
            <div className="app-section-heading">
              <p className="app-kicker">
                {t("homepage_eliza.marketing.downloadsKicker", {
                  defaultValue: "Downloads",
                })}
              </p>
              <h2 className="app-h2">
                {t("homepage_eliza.marketing.downloadsH2", {
                  defaultValue: "Install the app.",
                })}
              </h2>
              <p className="app-section-copy">
                {t("homepage_eliza.marketing.downloadsCopy", {
                  defaultValue:
                    "Release cards link directly to the published GitHub assets. Store distribution is listed separately and stays disabled until review is complete.",
                })}
              </p>
            </div>
            <div className="app-download-grid">
              {downloads.map((download) => {
                const Icon = download.icon;
                return (
                  <DownloadLink key={download.id} {...download} icon={Icon} />
                );
              })}
            </div>

            <ul
              className="app-store-grid"
              aria-label={t("homepage_eliza.marketing.storeGridAria", {
                defaultValue: "App store status",
              })}
            >
              {releaseData.storeTargets.map((target) => (
                <li className="app-store-card" key={target.platform}>
                  <Store className="app-icon" aria-hidden="true" />
                  <div>
                    <strong>{target.label}</strong>
                    <span>
                      {t("homepage_eliza.marketing.storeComingSoon", {
                        defaultValue: "Coming soon · {{channel}}",
                        channel: target.rolloutChannel,
                      })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>

            <section
              className="app-os-downloads"
              aria-label={t("homepage_eliza.marketing.osDownloadsAria", {
                defaultValue: "elizaOS distributions",
              })}
            >
              <h3 className="app-h3">
                {t("homepage_eliza.marketing.osDownloadsH3", {
                  defaultValue: "elizaOS — full operating system",
                })}
              </h3>
              <p className="app-section-copy">
                {t("homepage_eliza.marketing.osDownloadsCopy", {
                  defaultValue:
                    "Every elizaOS distribution is listed here. Cards with a working link download the published artifact; the rest are still in build and will activate as soon as a release is published.",
                })}
              </p>
              <ul className="app-os-grid" data-testid="os-artifact-grid">
                {releaseData.osArtifacts.map((artifact) => {
                  const available = Boolean(artifact.downloadUrl);
                  const statusLabel = available
                    ? artifact.channel === "stable"
                      ? t("homepage_eliza.marketing.osStatusAvailable", {
                          defaultValue: "Available",
                        })
                      : artifact.channel === "beta"
                        ? t("homepage_eliza.marketing.osStatusBeta", {
                            defaultValue: "Beta",
                          })
                        : t("homepage_eliza.marketing.osStatusNightly", {
                            defaultValue: "Nightly",
                          })
                    : t("homepage_eliza.marketing.osStatusComingSoon", {
                        defaultValue: "Coming soon",
                      });
                  const sizeLabel =
                    artifact.sizeBytes != null
                      ? ` · ${(artifact.sizeBytes / 1_048_576).toFixed(1)} MB`
                      : "";
                  const Tag = available ? "a" : "div";
                  return (
                    <li key={artifact.id}>
                      <Tag
                        className="app-os-card"
                        data-status={available ? "available" : "pending"}
                        data-artifact-id={artifact.id}
                        {...(available
                          ? {
                              href: artifact.downloadUrl as string,
                              rel: "noopener",
                            }
                          : { "aria-disabled": "true" })}
                      >
                        <div className="app-os-card-head">
                          <strong>{artifact.label}</strong>
                          <span className="app-os-status">
                            {statusLabel}
                            {sizeLabel}
                          </span>
                        </div>
                        <p>{artifact.description}</p>
                        <small>
                          {artifact.platform} · {artifact.kind} ·{" "}
                          {artifact.version}
                          {artifact.requiresHardware
                            ? ` · ${artifact.requiresHardware}`
                            : ""}
                        </small>
                      </Tag>
                    </li>
                  );
                })}
              </ul>
            </section>

            <div className="app-checksum-row">
              {releaseData.release.checksum ? (
                <a href={releaseData.release.checksum.url}>
                  <BadgeCheck className="app-icon" aria-hidden="true" />
                  {t("homepage_eliza.marketing.verifyWith", {
                    defaultValue: "Verify with {{file}}",
                    file: releaseData.release.checksum.fileName,
                  })}
                </a>
              ) : (
                <span>
                  {t("homepage_eliza.marketing.checksumPending", {
                    defaultValue: "Checksums publish with release assets.",
                  })}
                </span>
              )}
              <a href={releaseData.release.url}>
                {t("homepage_eliza.marketing.viewAllAssets", {
                  defaultValue: "View all assets",
                })}
                <ExternalLink className="app-icon" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        <section className="brand-section brand-section--black">
          <div className="app-band-inner app-action-grid">
            <ProductCta
              title={t("homepage_eliza.marketing.actionRunCloudTitle", {
                defaultValue: "Run in Cloud.",
              })}
              body={t("homepage_eliza.marketing.actionRunCloudBody", {
                defaultValue:
                  "Launch your agent runtime and account dashboard in Eliza Cloud.",
              })}
              href={cloudUrl}
              label={t("homepage_eliza.marketing.ctaTryCloud", {
                defaultValue: "Try Eliza Cloud",
              })}
              icon={Cloud}
            />
            <ProductCta
              title={t("homepage_eliza.marketing.actionInstallOsTitle", {
                defaultValue: "Install elizaOS.",
              })}
              body={t("homepage_eliza.marketing.actionInstallOsBody", {
                defaultValue:
                  "Use the full operating system when you want device-level control.",
              })}
              href={osUrl}
              label={t("homepage_eliza.marketing.ctaInstallOs", {
                defaultValue: "Install elizaOS",
              })}
              icon={MonitorDown}
            />
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaWhite}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
            className="app-footer-logo"
            draggable={false}
          />
          <nav
            className="app-footer-nav"
            aria-label={t("homepage_eliza.marketing.footerNavAria", {
              defaultValue: "Footer",
            })}
          >
            <a href={webAppUrl}>
              {t("homepage_eliza.marketing.footerWebApp", {
                defaultValue: "Web app",
              })}
            </a>
            <a href="#download">
              {t("homepage_eliza.marketing.navDownloads", {
                defaultValue: "Downloads",
              })}
            </a>
            <a href={cloudUrl}>
              {t("homepage_eliza.marketing.footerCloud", {
                defaultValue: "Eliza Cloud",
              })}
            </a>
            <a href={osUrl}>
              {t("homepage_eliza.marketing.footerOs", {
                defaultValue: "ElizaOS",
              })}
            </a>
            <a href={releaseData.release.url}>
              {t("homepage_eliza.marketing.footerReleases", {
                defaultValue: "GitHub Releases",
              })}
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function DownloadLink({
  label,
  href,
  detail,
  meta,
  fileName,
  description,
  icon: Icon,
}: {
  label: string;
  href: string;
  detail: string;
  meta: string;
  fileName: string;
  description: string;
  icon: typeof Package;
}) {
  return (
    <a className="app-download-card" href={href}>
      <span className="app-card-icon">
        <Icon className="app-icon" aria-hidden="true" />
      </span>
      <span className="app-download-card-copy">
        <strong>{label}</strong>
        <span>{description}</span>
        <small>{fileName}</small>
      </span>
      <span className="app-download-card-meta">
        <span>{detail}</span>
        <span>{meta}</span>
      </span>
      <ArrowRight className="app-icon app-card-arrow" aria-hidden="true" />
    </a>
  );
}

function ProductCta({
  title,
  body,
  href,
  label,
  icon: Icon,
}: {
  title: string;
  body: string;
  href: string;
  label: string;
  icon: typeof Package;
}) {
  return (
    <article className="app-product-cta">
      <div>
        <Icon className="app-product-icon" aria-hidden="true" />
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <a href={href} className="app-cta app-cta--white">
        {label}
        <ArrowRight className="app-icon" aria-hidden="true" />
      </a>
    </article>
  );
}
