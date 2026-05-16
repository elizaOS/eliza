import {
  ArrowRight,
  Cloud,
  Cpu,
  MessageCircle,
  Mic,
  Smartphone,
} from "lucide-react";

const cloudUrl = "https://elizacloud.ai";
const osUrl = "https://elizaos.ai";

export default function MarketingPage() {
  return (
    <div className="theme-app app-shell">
      <header className="app-header">
        <a href="/" aria-label="Eliza home" className="app-brand">
          <img
            src="/brand/logos/eliza_text_black.svg"
            alt="Eliza"
            draggable={false}
            className="app-brand-mark"
          />
        </a>
        <nav className="app-nav">
          <a href="#download">Download</a>
          <a href="#features">Features</a>
          <a href="/leaderboard">Leaderboard</a>
          <a href={cloudUrl} className="app-nav-pill">
            Eliza Cloud
          </a>
        </nav>
      </header>

      <section className="brand-section brand-section--orange app-hero">
        <p className="app-eyebrow">Eliza · the agent app</p>
        <h1 className="app-display">
          Your Eliza,
          <br />
          everywhere.
        </h1>
        <div className="app-cta-row">
          <a href="#download" className="app-cta app-cta--dark">
            Download for macOS
            <ArrowRight className="app-icon" />
          </a>
          <a href="#download" className="app-cta app-cta--outline">
            Windows · Linux · iOS · Android
          </a>
        </div>
      </section>

      <section id="features" className="brand-section brand-section--white">
        <div className="app-narrow">
          <p className="app-eyebrow app-eyebrow--dark">What you get</p>
          <h2 className="app-h2">One app, every interface.</h2>
          <div className="app-feature-grid">
            <Feature
              icon={<MessageCircle />}
              title="Chat with Eliza"
            />
            <Feature icon={<Mic />} title="Voice" />
            <Feature
              icon={<Cloud />}
              title="Connectors"
            />
            <Feature icon={<Cpu />} title="Local or cloud" />
            <Feature icon={<Smartphone />} title="Mobile" />
            <Feature icon={<Cloud />} title="Open source" />
          </div>
        </div>
      </section>

      <section id="download" className="brand-section brand-section--black">
        <div className="app-narrow">
          <p className="app-eyebrow">Download</p>
          <h2 className="app-h2 app-h2--invert">Get Eliza today.</h2>
          <div className="app-download-grid">
            <Download
              platform="macOS"
              detail="Apple Silicon · Intel"
              href="/downloads/Eliza.dmg"
            />
            <Download
              platform="Windows"
              detail="64-bit · MSIX"
              href="/downloads/Eliza.exe"
            />
            <Download
              platform="Linux"
              detail="deb · AppImage"
              href="/downloads/Eliza.AppImage"
            />
            <Download
              platform="iOS"
              detail="TestFlight"
              href="https://testflight.apple.com"
            />
            <Download
              platform="Android"
              detail="Play Store · APK"
              href="https://play.google.com"
            />
            <Download
              platform="Web"
              detail="Open in browser"
              href="https://elizacloud.ai"
            />
          </div>
        </div>
      </section>

      <section className="brand-section brand-section--blue">
        <div className="app-narrow app-split">
          <div>
            <h2 className="app-h2 app-h2--invert">Powered by elizaOS.</h2>
          </div>
          <a href={osUrl} className="app-cta app-cta--white">
            Install elizaOS
            <ArrowRight className="app-icon" />
          </a>
        </div>
      </section>

      <section className="brand-section brand-section--gray">
        <div className="app-narrow app-split">
          <div>
            <h2 className="app-h2">Or skip install. Open the cloud.</h2>
          </div>
          <a href={cloudUrl} className="app-cta app-cta--dark">
            <Cloud className="app-icon" /> Open Eliza Cloud
          </a>
        </div>
      </section>

      <footer className="app-footer">
        <div className="app-footer-inner">
          <img
            src="/brand/logos/eliza_text_white.svg"
            alt="Eliza"
            className="app-brand-mark"
            draggable={false}
          />
          <nav className="app-footer-nav">
            <a href="/leaderboard">Leaderboard</a>
            <a href={cloudUrl}>Cloud</a>
            <a href={osUrl}>elizaOS</a>
            <a href="https://github.com/elizaOS/eliza">GitHub</a>
          </nav>
          <p className="app-footer-copy">© 2026 Eliza · powered by elizaOS</p>
        </div>
      </footer>
    </div>
  );
}

function Feature({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <article className="app-feature-tile">
      <span className="app-feature-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
    </article>
  );
}

function Download({
  platform,
  detail,
  href,
}: {
  platform: string;
  detail: string;
  href: string;
}) {
  return (
    <a className="app-download-tile" href={href}>
      <span className="app-download-platform">{platform}</span>
      <span className="app-download-detail">{detail}</span>
      <ArrowRight className="app-icon" />
    </a>
  );
}
