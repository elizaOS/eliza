import { ArrowRight, Download } from "lucide-react";
import { releaseData } from "@/generated/release-data";

const cloudUrl = "https://elizacloud.ai/login?intent=launch";
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
      detail: releaseDownload?.sizeLabel ?? "GitHub Releases",
      meta: releaseDownload
        ? `From ${releaseDownload.releaseTagName}`
        : "Opens release page",
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
          <a href="#download" className="app-nav-download">
            Download
          </a>
          <a href={cloudUrl}>Eliza Cloud</a>
        </nav>
      </header>

      <main>
        <section className="brand-section brand-section--orange app-hero">
          <div className="app-band-inner app-hero-grid">
            <div className="app-hero-copy">
              <h1 className="app-display">Your Eliza, everywhere.</h1>
              <p className="app-lede">Download the app.</p>
              <div className="app-cta-row">
                <a href="#download" className="app-cta app-cta--black">
                  <Download className="app-icon" aria-hidden="true" />
                  Download the app
                </a>
                <a
                  href={cloudUrl}
                  className="app-cta app-cta--orange-secondary"
                >
                  Launch Eliza
                  <ArrowRight className="app-icon" aria-hidden="true" />
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
              <h2 className="app-h2 app-h2--light">Install.</h2>
            </div>

            <div className="app-download-list">
              {downloads.map((download) => (
                <DownloadLink key={download.id} {...download} />
              ))}
            </div>

          </div>
        </section>

        <section className="brand-section brand-section--blue">
          <div className="app-band-inner app-action-band">
            <div>
              <h2 className="app-h2 app-h2--light">Install the OS.</h2>
            </div>
            <a href={osUrl} className="app-cta app-cta--white">
              ElizaOS
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
              <h2 className="app-h2">Run in cloud.</h2>
            </div>
            <a href={cloudUrl} className="app-cta app-cta--orange">
              Launch Eliza
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
}: {
  label: string;
  href: string;
  detail: string;
  meta: string;
}) {
  return (
    <a className="app-download-row" href={href}>
      <span>{label}</span>
      <span>{detail}</span>
      <span>{meta}</span>
      <ArrowRight className="app-icon" aria-hidden="true" />
    </a>
  );
}
