import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared-brand";
import { CloudVideoBackground } from "@elizaos/ui";
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

const cloudUrl = `${EXTERNAL_URLS.cloud}/login?intent=launch`;
const osUrl = EXTERNAL_URLS.os;
const releaseFallbackUrl = `${EXTERNAL_URLS.github}/releases`;

const primaryDownloadIds = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "android-apk",
] as const;

const fallbackDownloads: Record<(typeof primaryDownloadIds)[number], string> = {
  "macos-arm64": "macOS Apple Silicon",
  "macos-x64": "macOS Intel",
  "windows-x64": "Windows",
  "linux-x64": "Linux",
  "android-apk": "Android APK",
};

const platformDescriptions: Record<
  (typeof primaryDownloadIds)[number],
  string
> = {
  "macos-arm64": "For M1, M2, M3, and newer Apple Silicon Macs.",
  "macos-x64": "For Intel Macs.",
  "windows-x64": "For 64-bit Windows PCs.",
  "linux-x64": "For 64-bit Linux desktops.",
  "android-apk": "Direct APK sideload while Play Store review is pending.",
};

const platformIcon: Record<
  (typeof primaryDownloadIds)[number],
  typeof Package
> = {
  "macos-arm64": MonitorDown,
  "macos-x64": MonitorDown,
  "windows-x64": MonitorDown,
  "linux-x64": Package,
  "android-apk": Smartphone,
};

export default function MarketingPage() {
  const downloads = primaryDownloadIds.map((id) => {
    const releaseDownload = releaseData.release.downloads.find(
      (download) => download.id === id,
    );
    const Icon = platformIcon[id];

    return {
      id,
      label: releaseDownload?.label ?? fallbackDownloads[id],
      href: releaseDownload?.url ?? releaseFallbackUrl,
      detail: releaseDownload
        ? `${releaseDownload.note} · ${releaseDownload.sizeLabel}`
        : "Release page",
      meta: releaseDownload
        ? `From ${releaseDownload.releaseTagName}`
        : "Opens release page",
      fileName: releaseDownload?.fileName ?? "Latest release",
      description: platformDescriptions[id],
      icon: Icon,
    };
  });

  return (
    <div className="theme-app app-shell">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[#FF5800]"
      >
        Skip to content
      </a>
      <header className="app-header">
        <a href="/" aria-label="Eliza home" className="app-brand">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaLockupBlack}`}
            alt="Eliza"
            draggable={false}
            className="app-brand-mark"
          />
        </a>
        <nav className="app-nav" aria-label="Eliza products">
          <a href="#download">Downloads</a>
          <a href={cloudUrl}>Cloud</a>
          <a href={osUrl}>OS</a>
          <a href="#download" className="app-nav-download">
            Download
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="brand-section brand-section--cloud app-hero">
          <CloudVideoBackground
            speed="4x"
            basePath={BRAND_PATHS.clouds}
            poster={BRAND_PATHS.poster}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
            }}
          />
          <div className="app-cloud-scrim" />
          <div className="app-band-inner app-hero-grid app-hero-copy--cloud">
            <div className="app-hero-copy">
              <p className="app-kicker">Eliza App</p>
              <h1 className="app-display">Your Eliza, everywhere.</h1>
              <p className="app-lede">
                Download the desktop and mobile app, connect one agent across
                your devices, and keep Cloud and elizaOS one click away.
              </p>
              <div className="app-cta-row">
                <a href="#download" className="app-cta app-cta--black">
                  <Download className="app-icon" aria-hidden="true" />
                  Download the app
                </a>
                <a href={cloudUrl} className="app-cta app-cta--glass">
                  <Cloud className="app-icon" aria-hidden="true" />
                  Try Eliza Cloud
                </a>
                <a href={osUrl} className="app-cta app-cta--ghost">
                  Install elizaOS
                  <ArrowRight className="app-icon" aria-hidden="true" />
                </a>
              </div>
            </div>
            <section className="app-release-panel" aria-label="Current release">
              <div>
                <span className="app-pill">Latest release</span>
                <h2>{releaseData.release.tagName}</h2>
                <p>{releaseData.release.publishedAtLabel}</p>
              </div>
              <a href={releaseData.release.url} className="app-release-link">
                Release notes
                <ExternalLink className="app-icon" aria-hidden="true" />
              </a>
            </section>
          </div>
        </section>

        <section id="download" className="brand-section brand-section--white">
          <div className="app-band-inner app-download-band">
            <div className="app-section-heading">
              <p className="app-kicker">Downloads</p>
              <h2 className="app-h2">Install the app.</h2>
              <p className="app-section-copy">
                Release cards link directly to the published GitHub assets.
                Store distribution is listed separately and stays disabled until
                review is complete.
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

            <ul className="app-store-grid" aria-label="App store status">
              {releaseData.storeTargets.map((target) => (
                <li className="app-store-card" key={target.platform}>
                  <Store className="app-icon" aria-hidden="true" />
                  <div>
                    <strong>{target.label}</strong>
                    <span>Coming soon · {target.rolloutChannel}</span>
                  </div>
                </li>
              ))}
            </ul>

            <div className="app-checksum-row">
              {releaseData.release.checksum ? (
                <a href={releaseData.release.checksum.url}>
                  <BadgeCheck className="app-icon" aria-hidden="true" />
                  Verify with {releaseData.release.checksum.fileName}
                </a>
              ) : (
                <span>Checksums publish with release assets.</span>
              )}
              <a href={releaseData.release.url}>
                View all assets
                <ExternalLink className="app-icon" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        <section className="brand-section brand-section--black">
          <div className="app-band-inner app-action-grid">
            <ProductCta
              title="Run in Cloud."
              body="Launch your agent runtime and account dashboard in Eliza Cloud."
              href={cloudUrl}
              label="Try Eliza Cloud"
              icon={Cloud}
            />
            <ProductCta
              title="Install elizaOS."
              body="Use the full operating system when you want device-level control."
              href={osUrl}
              label="Install elizaOS"
              icon={MonitorDown}
            />
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.elizaWhite}`}
            alt="Eliza"
            className="app-footer-logo"
            draggable={false}
          />
          <nav className="app-footer-nav" aria-label="Footer">
            <a href="#download">Downloads</a>
            <a href={cloudUrl}>Eliza Cloud</a>
            <a href={osUrl}>ElizaOS</a>
            <a href={releaseData.release.url}>GitHub Releases</a>
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
