/**
 * Public elizaOS homepage. A short product thesis with live release downloads.
 */
import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import { releaseData } from "@/generated/release-data";
import { useT } from "@/providers/I18nProvider";

const webAppUrl = EXTERNAL_URLS.app;
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

const fallbackLabels: Record<DownloadId, string> = {
  "macos-arm64": "macOS · Apple Silicon",
  "macos-x64": "macOS · Intel",
  "windows-x64": "Windows · x64",
  "linux-x64": "Linux · x64",
  "linux-deb": "Ubuntu / Debian",
  "android-apk": "Android · APK",
};

const fallbackLabelKeys: Record<DownloadId, string> = {
  "macos-arm64": "homepage_eliza.marketing.fallbackMacosArm64",
  "macos-x64": "homepage_eliza.marketing.fallbackMacosX64",
  "windows-x64": "homepage_eliza.marketing.fallbackWindowsX64",
  "linux-x64": "homepage_eliza.marketing.fallbackLinuxX64",
  "linux-deb": "homepage_eliza.marketing.fallbackLinuxDeb",
  "android-apk": "homepage_eliza.marketing.fallbackAndroidApk",
};

export default function MarketingPage() {
  const t = useT();
  const sovereign = (name: string, defaultValue: string) =>
    t(`homepage_eliza.sovereign.${name}`, { defaultValue });
  const copy = {
    navSystem: sovereign("navSystem", "System"),
    navPaper: sovereign("navPaper", "Orange Paper"),
    eyebrow: sovereign("eyebrow", "Open agent operating system · MIT licensed"),
    heroMoney: sovereign("heroMoney", "Bitcoin gave you sovereign money."),
    heroMind: sovereign("heroMind", "elizaOS gives you a sovereign mind."),
    heroLede: sovereign(
      "heroLede",
      "The open OS for private, persistent agents. One agent, every surface, on infrastructure you control.",
    ),
    download: sovereign("download", "Download Eliza"),
    webApp: sovereign("webApp", "Open web app"),
    systemKicker: sovereign("systemKicker", "The system"),
    control: sovereign("control", "Control is architecture."),
    source: sovereign("source", "Source"),
    openInspectable: sovereign("openInspectable", "Open and inspectable"),
    state: sovereign("state", "State"),
    privatePersistent: sovereign("privatePersistent", "Private and persistent"),
    runtime: sovereign("runtime", "Runtime"),
    oneEverySurface: sovereign("oneEverySurface", "One agent, every surface"),
    cloud: sovereign("cloud", "Cloud"),
    availableNotRequired: sovereign(
      "availableNotRequired",
      "Available, not required",
    ),
    yours: sovereign("yours", "yours"),
    portable: sovereign("portable", "portable"),
    optional: sovereign("optional", "optional"),
    proofKicker: sovereign("proofKicker", "One agent · every surface"),
    surfaces: sovereign(
      "surfaces",
      "The interface changes. The agent does not.",
    ),
    proofBody: sovereign(
      "proofBody",
      "Identity, memory, and permissions stay attached to the runtime, from desktop to phone to messaging and edge hardware.",
    ),
    desktop: sovereign("desktop", "Desktop"),
    phone: sovereign("phone", "Phone"),
    messages: sovereign("messages", "Messages"),
    edge: sovereign("edge", "Edge"),
    distributions: sovereign("distributions", "elizaOS distributions"),
    installers: sovereign("installers", "device images and installers"),
    closingKicker: sovereign(
      "closingKicker",
      "Open source · private by architecture",
    ),
    closing: sovereign("closing", "Your agent should answer to you."),
    readPaper: sovereign("readPaper", "Read the Orange Paper"),
    footerTagline: sovereign(
      "footerTagline",
      "elizaOS · open agent operating system",
    ),
    backTop: sovereign("backTop", "Back to top"),
  };
  const stableDownloads = releaseData.release.downloads;
  const canaryDownloads = releaseData.canaryRelease?.downloads ?? [];
  const effectiveDownloads =
    stableDownloads.length > 0 ? stableDownloads : canaryDownloads;
  const downloads = primaryDownloadIds.map((id) => {
    const releaseDownload = effectiveDownloads.find(
      (download) => download.id === id,
    );
    return {
      id,
      label:
        releaseDownload?.label ??
        t(fallbackLabelKeys[id], { defaultValue: fallbackLabels[id] }),
      href: releaseDownload?.url ?? releaseFallbackUrl,
      fileName:
        releaseDownload?.fileName ??
        t("homepage_eliza.marketing.releaseFallbackFile", {
          defaultValue: "Latest release",
        }),
      detail: releaseDownload
        ? t("homepage_eliza.marketing.releaseDetail", {
            defaultValue: "{{note}} · {{sizeLabel}}",
            note: releaseDownload.note,
            sizeLabel: releaseDownload.sizeLabel,
          })
        : t("homepage_eliza.marketing.releaseFallbackDetail", {
            defaultValue: "Release page",
          }),
    };
  });

  return (
    <div className="sovereign-site">
      <a className="sovereign-skip" href="#main">
        {t("homepage_eliza.common.skipToContent", {
          defaultValue: "Skip to content",
        })}
      </a>

      <header className="sovereign-nav">
        <a className="sovereign-brand" href="/" aria-label="elizaOS home">
          <img
            className="sovereign-brand-mark"
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.markOrangeNoBg}`}
            alt=""
          />
          <img
            className="sovereign-brand-word"
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
            alt="elizaOS"
          />
        </a>
        <nav aria-label="Primary navigation">
          <a href="#system">{copy.navSystem}</a>
          <a href="/orange-paper">{copy.navPaper}</a>
          <a href={EXTERNAL_URLS.github}>GitHub</a>
        </nav>
      </header>

      <main id="main">
        <section className="sovereign-hero" aria-labelledby="hero-title">
          <div className="sovereign-hero-copy">
            <p className="sovereign-eyebrow">{copy.eyebrow}</p>
            <h1 id="hero-title">
              {copy.heroMoney}
              <span>{copy.heroMind}</span>
            </h1>
            <p className="sovereign-lede">{copy.heroLede}</p>
            <div className="sovereign-actions">
              <a className="sovereign-primary" href="#download">
                <span>{copy.download}</span>
                <span aria-hidden="true">↓</span>
              </a>
              <a className="sovereign-secondary" href={webAppUrl}>
                {copy.webApp} <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>

          <aside
            className="sovereign-plate"
            aria-label="One agent across every surface"
          >
            <div className="sovereign-plate-head">
              <span>ONE RUNTIME</span>
              <span>ELZ / 01</span>
            </div>
            <div className="sovereign-orbit" aria-hidden="true">
              <div className="sovereign-axis sovereign-axis-x" />
              <div className="sovereign-axis sovereign-axis-y" />
              <span className="sovereign-node sovereign-node-phone">
                {copy.phone}
              </span>
              <span className="sovereign-node sovereign-node-desktop">
                {copy.desktop}
              </span>
              <span className="sovereign-node sovereign-node-messages">
                {copy.messages}
              </span>
              <span className="sovereign-node sovereign-node-edge">
                {copy.edge}
              </span>
              <div className="sovereign-core">
                <img
                  src={`${BRAND_PATHS.logos}/${LOGO_FILES.markOrangeNoBg}`}
                  alt=""
                />
              </div>
            </div>
            <div className="sovereign-plate-foot">
              <span>
                <i /> RUNTIME READY
              </span>
              <span>LOCAL · PRIVATE · PORTABLE</span>
            </div>
          </aside>
        </section>

        <section
          id="system"
          className="sovereign-claim"
          aria-labelledby="system-title"
        >
          <div>
            <p className="sovereign-eyebrow sovereign-eyebrow-dark">
              {copy.systemKicker}
            </p>
            <h2 id="system-title">{copy.control}</h2>
          </div>
          <dl className="sovereign-ledger">
            <div>
              <dt>{copy.source}</dt>
              <dd>{copy.openInspectable}</dd>
              <small>MIT</small>
            </div>
            <div>
              <dt>{copy.state}</dt>
              <dd>{copy.privatePersistent}</dd>
              <small>{copy.yours}</small>
            </div>
            <div>
              <dt>{copy.runtime}</dt>
              <dd>{copy.oneEverySurface}</dd>
              <small>{copy.portable}</small>
            </div>
            <div>
              <dt>{copy.cloud}</dt>
              <dd>{copy.availableNotRequired}</dd>
              <small>{copy.optional}</small>
            </div>
          </dl>
        </section>

        <section className="sovereign-proof" aria-labelledby="proof-title">
          <div className="sovereign-proof-title">
            <p className="sovereign-eyebrow">{copy.proofKicker}</p>
            <h2 id="proof-title">{copy.surfaces}</h2>
          </div>
          <p>{copy.proofBody}</p>
          <ul
            className="sovereign-surface-line"
            aria-label="Supported surfaces"
          >
            <li>{copy.desktop}</li>
            <i aria-hidden="true" />
            <li>{copy.phone}</li>
            <i aria-hidden="true" />
            <li>{copy.messages}</li>
            <i aria-hidden="true" />
            <li>{copy.edge}</li>
          </ul>
        </section>

        <section
          id="download"
          className="sovereign-download"
          aria-labelledby="download-title"
        >
          <div className="sovereign-download-intro">
            <p className="sovereign-eyebrow sovereign-eyebrow-dark">
              {t("homepage_eliza.marketing.releaseLabel", {
                defaultValue: "Current release",
              })}
            </p>
            <h2 id="download-title">{copy.download}.</h2>
            <p>
              {releaseData.release.tagName} ·{" "}
              {releaseData.release.publishedAtLabel}
            </p>
            <a href={releaseData.release.url}>
              {t("homepage_eliza.marketing.releaseNotes", {
                defaultValue: "Release notes",
              })}{" "}
              ↗
            </a>
          </div>

          <ul className="sovereign-download-list app-download-grid">
            {downloads.map((download) => (
              <li key={download.id}>
                <a href={download.href}>
                  <span>
                    <strong>{download.label}</strong>
                    <small>{download.fileName}</small>
                  </span>
                  <span>{download.detail}</span>
                  <b aria-hidden="true">↓</b>
                </a>
              </li>
            ))}
          </ul>

          <div className="sovereign-download-foot">
            {releaseData.release.checksum ? (
              <a href={releaseData.release.checksum.url}>
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
              })}{" "}
              ↗
            </a>
          </div>

          <ul
            className="sovereign-store-links"
            aria-label="App store availability"
          >
            {releaseData.storeTargets.map((target) => (
              <li key={target.platform}>
                {target.url ? (
                  <a href={target.url}>
                    <span>{target.label}</span>
                    <small>{target.rolloutChannel}</small>
                  </a>
                ) : (
                  <span aria-disabled="true">
                    <span>{target.label}</span>
                    <small>
                      {t("homepage_eliza.marketing.storeComingSoon", {
                        defaultValue: "Coming soon · {{channel}}",
                        channel: target.rolloutChannel,
                      })}
                    </small>
                  </span>
                )}
              </li>
            ))}
          </ul>

          <details className="sovereign-os-distributions">
            <summary>
              {copy.distributions} <span>{copy.installers}</span>
            </summary>
            <ul data-testid="os-artifact-grid">
              {releaseData.osArtifacts.map((artifact) => {
                const available = Boolean(artifact.downloadUrl);
                const Tag = available ? "a" : "div";
                return (
                  <li key={artifact.id}>
                    <Tag
                      data-artifact-id={artifact.id}
                      data-status={available ? "available" : "pending"}
                      {...(available
                        ? {
                            href: artifact.downloadUrl as string,
                            rel: "noopener",
                          }
                        : { "aria-disabled": "true" })}
                    >
                      <span>
                        <strong>{artifact.label}</strong>
                        <small>
                          {artifact.platform} · {artifact.kind}
                        </small>
                      </span>
                      <span>
                        {available
                          ? artifact.channel
                          : t("homepage_eliza.marketing.osStatusComingSoon", {
                              defaultValue: "Coming soon",
                            })}
                      </span>
                    </Tag>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>

        <section className="sovereign-close" aria-labelledby="close-title">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.markOrangeNoBg}`}
            alt=""
          />
          <div>
            <p className="sovereign-eyebrow">{copy.closingKicker}</p>
            <h2 id="close-title">{copy.closing}</h2>
          </div>
          <a href="/orange-paper">
            {copy.readPaper} <span aria-hidden="true">→</span>
          </a>
        </section>
      </main>

      <footer className="sovereign-footer">
        <span>{copy.footerTagline}</span>
        <nav
          aria-label={t("homepage_eliza.marketing.footerNavAria", {
            defaultValue: "Footer",
          })}
        >
          <a href={EXTERNAL_URLS.github}>GitHub</a>
          <a href={EXTERNAL_URLS.docs}>Docs</a>
          <a href={EXTERNAL_URLS.cloud}>Cloud</a>
          <a href={EXTERNAL_URLS.os}>elizaOS</a>
          <a href={EXTERNAL_URLS.discord}>Discord</a>
          <a href="#main">{copy.backTop}</a>
        </nav>
      </footer>
    </div>
  );
}
