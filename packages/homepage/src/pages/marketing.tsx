import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
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
      detail: releaseDownload?.sizeLabel ?? "Release page",
      meta: releaseDownload
        ? `From ${releaseDownload.releaseTagName}`
        : "Opens release page",
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
          <a href="#download" className="app-nav-download">
            Download
          </a>
          <a href={cloudUrl}>Eliza Cloud</a>
        </nav>
      </header>

      <main id="main">
        <section className="brand-section brand-section--cloud app-hero">
          <video
            className="app-cloud-video"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            poster={BRAND_PATHS.poster}
          >
            <source
              src={`${BRAND_PATHS.clouds}/clouds_4x_720p.webm`}
              type="video/webm"
            />
            <source
              src={`${BRAND_PATHS.clouds}/clouds_4x_720p.mp4`}
              type="video/mp4"
            />
          </video>
          <div className="app-cloud-scrim" />
          <div className="app-band-inner app-hero-copy app-hero-copy--cloud">
            <h1 className="app-display">Your Eliza, everywhere.</h1>
            <p className="app-lede">Desktop, mobile, and cloud — one Eliza.</p>
            <div className="app-cta-row">
              <a href="#download" className="app-cta app-cta--black">
                <Download className="app-icon" aria-hidden="true" />
                Download the app
              </a>
              <a href={cloudUrl} className="app-cta app-cta--white">
                Launch Eliza
                <ArrowRight className="app-icon" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>

        <section id="download" className="brand-section brand-section--black">
          <div className="app-band-inner app-download-band">
            <h2 className="app-h2 app-h2--light">Install.</h2>
            <div className="app-download-list">
              {downloads.map((download) => (
                <DownloadLink key={download.id} {...download} />
              ))}
            </div>
          </div>
        </section>

        <section className="brand-section brand-section--blue">
          <div className="app-band-inner app-action-band">
            <h2 className="app-h2 app-h2--light">Install the OS.</h2>
            <a href={osUrl} className="app-cta app-cta--white">
              ElizaOS
              <ArrowRight className="app-icon" aria-hidden="true" />
            </a>
          </div>
        </section>

        <section className="brand-section brand-section--orange">
          <div className="app-band-inner app-action-band">
            <h2 className="app-h2">Run in cloud.</h2>
            <a href={cloudUrl} className="app-cta app-cta--black">
              Launch Eliza
              <ArrowRight className="app-icon" aria-hidden="true" />
            </a>
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
            <a href={osUrl}>elizaOS</a>
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
