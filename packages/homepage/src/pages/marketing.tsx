/**
 * Public homepage for eliza.app — demo-day deck style landing surface.
 *
 * Visual language mirrors the elizaOS demo-day deck: near-black canvas,
 * orange accent, Poppins headlines, mono uppercase tags, minimal copy, one
 * prominent click-through to Eliza Cloud. The functional download surface
 * (release cards, store status, elizaOS artifacts) is preserved below the
 * fold and restyled for the dark canvas.
 */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  ArrowRight,
  BadgeCheck,
  ExternalLink,
  MonitorDown,
  Package,
  Smartphone,
  Store,
} from "lucide-react";
import { releaseData } from "@/generated/release-data";
import { useT } from "@/providers/I18nProvider";

const cloudUrl = EXTERNAL_URLS.cloud;
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
    <div className="theme-app deck-shell">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[var(--brand-orange)]"
      >
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>
      <header className="deck-chrome">
        <a
          href="/"
          aria-label={t("homepage_eliza.common.brandHomeAria", {
            defaultValue: "Eliza home",
          })}
          className="deck-brand"
        >
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupWhite}`}
            alt={t("homepage_eliza.common.brandAlt", { defaultValue: "Eliza" })}
            draggable={false}
            className="deck-brand-mark"
          />
        </a>
        <nav
          className="deck-nav"
          aria-label={t("homepage_eliza.marketing.navProducts", {
            defaultValue: "Eliza products",
          })}
        >
          <a href="#download">
            {t("homepage_eliza.marketing.navDownloads", {
              defaultValue: "Downloads",
            })}
          </a>
          <a href={cloudUrl}>
            {t("homepage_eliza.marketing.navCloud", { defaultValue: "Cloud" })}
          </a>
        </nav>
      </header>

      <main id="main">
        <section
          className="brand-section deck-hero"
          aria-label={t("homepage_eliza.marketing.heroAria", {
            defaultValue: "Eliza",
          })}
        >
          <div className="deck-hero-grid">
            <div className="deck-hero-copy">
              <p className="deck-tag">
                {t("homepage_eliza.marketing.heroTag", {
                  defaultValue: "Eliza",
                })}
              </p>
              <h1 className="deck-hero-title">
                <span className="deck-hero-assurance">
                  {t("homepage_eliza.marketing.heroAssurance", {
                    defaultValue: "There’s nothing wrong with you.",
                  })}
                </span>
                <span className="deck-hero-reframe">
                  {t("homepage_eliza.marketing.heroReframe", {
                    defaultValue: "You’re just overwhelmed.",
                  })}
                </span>
              </h1>
              <p className="deck-lede">
                {t("homepage_eliza.marketing.heroDeckLede", {
                  defaultValue:
                    "Eliza manages your digital life so you can live your real one.",
                })}
              </p>
              <div className="deck-cta-row">
                <a href={cloudUrl} className="deck-cta">
                  {t("homepage_eliza.marketing.ctaOpenCloud", {
                    defaultValue: "Open Eliza Cloud",
                  })}
                  <ArrowRight className="app-icon" aria-hidden="true" />
                </a>
              </div>
            </div>
            <div className="deck-phone" aria-hidden="true">
              <img
                src="/phone-home.png"
                alt=""
                width={786}
                height={1704}
                draggable={false}
              />
            </div>
          </div>
        </section>

        <section className="brand-section deck-band">
          <p className="deck-tag">
            {t("homepage_eliza.marketing.platformTag", {
              defaultValue: "The platform",
            })}
          </p>
          <h2 className="deck-h2">
            {t("homepage_eliza.marketing.platformH2", {
              defaultValue: "The Linux of agents.",
            })}
          </h2>
          <p className="deck-band-copy">
            {t("homepage_eliza.marketing.platformCopy", {
              defaultValue:
                "Everything comes in. Only what matters reaches you.",
            })}
          </p>
        </section>

        <section id="download" className="brand-section deck-downloads">
          <div className="app-band-inner app-download-band">
            <div className="app-section-heading">
              <p className="deck-tag">
                {t("homepage_eliza.marketing.downloadsKicker", {
                  defaultValue: "Downloads",
                })}
              </p>
              <h2 className="deck-h2">
                {t("homepage_eliza.marketing.downloadsH2", {
                  defaultValue: "Install the app.",
                })}
              </h2>
              <p className="app-section-copy">
                {t("homepage_eliza.marketing.downloadsDeckCopy", {
                  defaultValue:
                    "Direct downloads from the latest published release.",
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
                {t("homepage_eliza.marketing.osDownloadsDeckCopy", {
                  defaultValue:
                    "Cards with a working link download the published artifact; the rest activate as releases publish.",
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
