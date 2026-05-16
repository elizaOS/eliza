import { ArrowRight, Download, ExternalLink } from "lucide-react";
import {
  type ReleaseDataDownload,
  releaseData,
} from "@/generated/release-data";

const cloudUrl = "https://www.elizacloud.ai/dashboard/my-agents";
const osUrl = "https://elizaos.ai";
const releaseFallbackUrl = "https://github.com/elizaOS/eliza/releases";

const primaryDownloadIds = [
  "macos-arm64",
  "windows-x64",
  "linux-x64",
  "android-apk",
] as const;

const fallbackDownloads: Record<(typeof primaryDownloadIds)[number], string> = {
  "macos-arm64": "macOS Apple Silicon",
  "windows-x64": "Windows x64",
  "linux-x64": "Linux AppImage",
  "android-apk": "Android APK",
};

export default function MarketingPage() {
  const downloads = primaryDownloadIds.map((id) => {
    const releaseDownload = releaseData.release.downloads.find(
      (download) => download.id === id,
    );

    return {
      id,
      label: releaseDownload?.label ?? fallbackDownloads[id],
      href: releaseDownload?.url ?? releaseFallbackUrl,
      meta: releaseDownload
        ? `From ${releaseDownload.releaseTagName}`
        : "Opens release page",
      download: releaseDownload,
    };
  });

  return (
    <div className="theme-app app-shell">
      <header className="app-header">
        <a href="/" aria-label="Eliza App home" className="app-brand">
          <img
            src="/brand/logos/eliza_logotext_black.svg"
            alt="Eliza App"
            draggable={false}
            className="app-brand-mark"
          />
        </a>
        <nav className="app-nav" aria-label="Eliza products">
          <a href="/" aria-current="page">
            Eliza App
          </a>
          <a href={osUrl}>ElizaOS</a>
          <a href={cloudUrl}>Eliza Cloud</a>
          <a href="#download" className="app-nav-download">
            Download
          </a>
        </nav>
      </header>

      <main>
        <section className="brand-section brand-section--orange app-hero">
          <div className="app-band-inner app-hero-grid">
            <div className="app-hero-copy">
              <p className="app-kicker">Eliza App</p>
              <h1 className="app-display">Download the app.</h1>
              <p className="app-lede">
                Your Eliza agent on desktop, mobile, and the web.
              </p>
              <div
                className="app-cta-row"
                role="group"
                aria-label="Primary actions"
              >
                <a href="#download" className="app-cta app-cta--black">
                  <Download className="app-icon" aria-hidden="true" />
                  Download the app
                </a>
                <a href={osUrl} className="app-cta app-cta--orange-secondary">
                  ElizaOS
                  <ExternalLink className="app-icon" aria-hidden="true" />
                </a>
                <a
                  href={cloudUrl}
                  className="app-cta app-cta--orange-secondary"
                >
                  Eliza Cloud
                  <ExternalLink className="app-icon" aria-hidden="true" />
                </a>
              </div>
            </div>
            <img
              src="/brand/logos/logo_white_orangebg.svg"
              alt=""
              className="app-hero-mark"
              draggable={false}
            />
          </div>
        </section>

        <section id="download" className="brand-section brand-section--black">
          <div className="app-band-inner app-download-band">
            <div>
              <p className="app-kicker app-kicker--light">Download</p>
              <h2 className="app-h2 app-h2--light">Install Eliza App.</h2>
            </div>

            <div
              className="app-download-list"
              role="group"
              aria-label="App downloads"
            >
              {downloads.map((download) => (
                <DownloadLink key={download.id} {...download} />
              ))}
            </div>

            <div
              className="app-store-list"
              role="group"
              aria-label="Store availability"
            >
              {releaseData.storeTargets.map((store) => (
                <div
                  key={store.platform}
                  className="app-store-row"
                  aria-disabled="true"
                >
                  <span>{store.label}</span>
                  <span>{store.reviewState}</span>
                  <span>Coming soon</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="brand-section brand-section--white">
          <div className="app-band-inner app-mini-grid">
            <div>
              <p className="app-kicker">App first</p>
              <h2 className="app-h2">Chat. Voice. Automate.</h2>
            </div>
            <p className="app-side-copy">
              One interface for your agent, local runtime, and cloud account.
            </p>
          </div>
        </section>

        <section className="brand-section brand-section--blue">
          <div className="app-band-inner app-action-band">
            <div>
              <p className="app-kicker app-kicker--light">Open source</p>
              <h2 className="app-h2 app-h2--light">Build on ElizaOS.</h2>
            </div>
            <a href={osUrl} className="app-cta app-cta--white">
              Go to ElizaOS
              <ArrowRight className="app-icon" aria-hidden="true" />
            </a>
          </div>
        </section>

        <section className="brand-section brand-section--cloud">
          <video
            className="app-cloud-video"
            autoPlay
            muted
            loop
            playsInline
            poster="/clouds/poster.jpg"
          >
            <source src="/clouds/clouds_4x_720p.webm" type="video/webm" />
            <source src="/clouds/clouds_4x_720p.mp4" type="video/mp4" />
          </video>
          <div className="app-band-inner app-action-band app-action-band--cloud">
            <div>
              <p className="app-kicker">Managed</p>
              <h2 className="app-h2">Continue in Eliza Cloud.</h2>
            </div>
            <a href={cloudUrl} className="app-cta app-cta--orange">
              Try Eliza Cloud
              <ArrowRight className="app-icon" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <img
            src="/brand/logos/eliza_text_white.svg"
            alt="Eliza"
            className="app-footer-logo"
            draggable={false}
          />
          <nav className="app-footer-nav" aria-label="Footer">
            <a href={osUrl}>ElizaOS</a>
            <a href={cloudUrl}>Eliza Cloud</a>
            <a href="https://github.com/elizaOS/eliza">GitHub</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function DownloadLink({
  label,
  href,
  meta,
  download,
}: {
  label: string;
  href: string;
  meta: string;
  download?: ReleaseDataDownload;
}) {
  return (
    <a className="app-download-row" href={href}>
      <span>{label}</span>
      <span>{download?.sizeLabel ?? meta}</span>
      <span>{meta}</span>
      <ArrowRight className="app-icon" aria-hidden="true" />
    </a>
  );
}
