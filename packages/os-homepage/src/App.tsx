import {
  ArrowRight,
  Check,
  Cloud,
  Cpu,
  Download,
  Terminal,
} from "lucide-react";

const cloudUrl = "https://elizacloud.ai";
const appUrl = "https://eliza.app";

export function App() {
  return (
    <div className="theme-os os-shell">
      <header className="os-header">
        <a href="/" className="os-brand" aria-label="elizaOS home">
          <img
            src="/brand/logos/elizaOS_text_white.svg"
            alt="elizaOS"
            className="os-brand-mark"
            draggable={false}
          />
        </a>
        <nav className="os-nav">
          <a href="#download">Download</a>
          <a href="#hardware">Hardware</a>
          <a href="/docs" rel="noopener">
            Docs
          </a>
          <a href={cloudUrl} className="os-nav-pill">
            Eliza Cloud
          </a>
        </nav>
      </header>

      <section className="brand-section brand-section--blue os-hero">
        <p className="os-eyebrow">elizaOS · open agent runtime</p>
        <h1 className="os-display">
          An operating system
          <br />
          for your agent.
        </h1>
        <p className="os-lede">
          elizaOS is the open-source runtime that powers Eliza. Run it on a
          phone, a laptop, a $4 USB stick, or your own cloud — your agent lives
          wherever you do.
        </p>
        <div className="os-cta-row">
          <a href="#download" className="os-cta os-cta--solid">
            Download elizaOS
            <ArrowRight className="os-icon" />
          </a>
          <a
            href="https://github.com/elizaOS/eliza"
            className="os-cta os-cta--ghost"
          >
            View source
          </a>
        </div>
      </section>

      <section id="download" className="brand-section brand-section--white">
        <div className="os-narrow">
          <p className="os-eyebrow os-eyebrow--dark">Install</p>
          <h2 className="os-h2">Get elizaOS in one command.</h2>
          <div className="os-install-grid">
            <article className="os-install-tile">
              <Terminal className="os-icon-lg" />
              <h3>macOS &amp; Linux</h3>
              <pre className="os-code">
                curl -fsSL https://elizaos.ai/install.sh | bash
              </pre>
            </article>
            <article className="os-install-tile">
              <Cpu className="os-icon-lg" />
              <h3>Windows</h3>
              <pre className="os-code">
                iwr -useb https://elizaos.ai/install.ps1 | iex
              </pre>
            </article>
            <article className="os-install-tile">
              <Download className="os-icon-lg" />
              <h3>Mobile</h3>
              <p className="os-tile-copy">
                Native iOS and Android builds are in TestFlight and the Play
                Store. Sideload from{" "}
                <a href="https://github.com/elizaOS/eliza/releases">
                  GitHub releases
                </a>
                .
              </p>
            </article>
          </div>
        </div>
      </section>

      <section id="hardware" className="brand-section brand-section--blue">
        <div className="os-narrow">
          <p className="os-eyebrow">Hardware</p>
          <h2 className="os-h2 os-h2--invert">Run Eliza on anything.</h2>
          <div className="os-hardware-grid">
            <article className="os-hardware-tile">
              <h3>Eliza Phone</h3>
              <p>
                Pixel-class Android with elizaOS preinstalled. Your agent in
                your pocket, no cloud round-trip required.
              </p>
              <ul>
                <li>
                  <Check className="os-icon" /> Local inference
                </li>
                <li>
                  <Check className="os-icon" /> Connected to Eliza Cloud
                </li>
                <li>
                  <Check className="os-icon" /> Open sideloading
                </li>
              </ul>
            </article>
            <article className="os-hardware-tile">
              <h3>Eliza Box</h3>
              <p>
                Mini PC with a GPU, designed to host one agent for one
                household. Plug in HDMI and it boots straight into Eliza.
              </p>
              <ul>
                <li>
                  <Check className="os-icon" /> Always-on home agent
                </li>
                <li>
                  <Check className="os-icon" /> Offline first
                </li>
                <li>
                  <Check className="os-icon" /> SSH + web dashboard
                </li>
              </ul>
            </article>
            <article className="os-hardware-tile">
              <h3>Eliza USB</h3>
              <p>
                Bootable USB stick that turns any laptop into an elizaOS
                workstation. Bring your agent on a keychain.
              </p>
              <ul>
                <li>
                  <Check className="os-icon" /> Persistent encrypted home
                </li>
                <li>
                  <Check className="os-icon" /> $39
                </li>
                <li>
                  <Check className="os-icon" /> Ships globally
                </li>
              </ul>
            </article>
          </div>
        </div>
      </section>

      <section className="brand-section brand-section--orange">
        <div className="os-narrow os-split">
          <div>
            <h2 className="os-h2">Built to talk to the app.</h2>
            <p className="os-paragraph os-paragraph--dark">
              elizaOS pairs with the Eliza app for voice, chat, connectors, and
              your phone. The OS is the runtime — the app is the face.
            </p>
          </div>
          <a href={appUrl} className="os-cta os-cta--dark">
            Get the Eliza app
            <ArrowRight className="os-icon" />
          </a>
        </div>
      </section>

      <section className="brand-section brand-section--black">
        <div className="os-narrow os-split">
          <div>
            <h2 className="os-h2 os-h2--invert">Or run it in the cloud.</h2>
            <p className="os-paragraph">
              Eliza Cloud hosts your agent on managed infra with one-click
              billing, custom domains, and creator monetization built in.
            </p>
          </div>
          <a href={cloudUrl} className="os-cta os-cta--invert">
            <Cloud className="os-icon" /> Open Eliza Cloud
          </a>
        </div>
      </section>

      <footer className="os-footer">
        <div className="os-footer-inner">
          <img
            src="/brand/logos/elizaOS_text_white.svg"
            alt="elizaOS"
            className="os-brand-mark"
            draggable={false}
          />
          <nav className="os-footer-nav">
            <a href="https://github.com/elizaOS/eliza">GitHub</a>
            <a href={cloudUrl}>Cloud</a>
            <a href={appUrl}>App</a>
            <a href="/docs">Docs</a>
          </nav>
          <p className="os-footer-copy">© 2026 elizaOS contributors</p>
        </div>
      </footer>
    </div>
  );
}
