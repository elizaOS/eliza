import {
  ArrowRight,
  Check,
  Cloud,
  Cpu,
  Download,
  Terminal,
} from "lucide-react";
import { CloudVideoBackground } from "@elizaos/ui";

const cloudUrl = "https://elizacloud.ai";
const appUrl = "https://eliza.app";
const discordUrl = "https://discord.gg/eliza";
const twitterUrl = "https://x.com/elizaos";
const githubUrl = "https://github.com/elizaOS/eliza";

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

      <section className="os-clouds-band" aria-label="Cloudless by design">
        <CloudVideoBackground
          speed="8x"
          basePath="/clouds"
          scrim={0}
        >
          <div className="os-clouds-band-inner">
            <p className="os-eyebrow os-eyebrow--ink">Local first</p>
            <h2 className="os-clouds-headline">
              Cloudless,
              <br />
              by design.
            </h2>
            <p className="os-clouds-sub">
              Your agent runs on your hardware. The cloud is optional, never
              required.
            </p>
          </div>
        </CloudVideoBackground>
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
                Android system image with elizaOS flashed at the vendor layer.
                Local Bun runtime, on-device inference, sideloading open.
              </p>
              <ul>
                <li>
                  <Check className="os-icon" /> Local Bun agent runtime
                </li>
                <li>
                  <Check className="os-icon" /> Optional Eliza Cloud routing
                </li>
                <li>
                  <Check className="os-icon" /> Open sideloading + ADB
                </li>
              </ul>
            </article>
            <article className="os-hardware-tile">
              <h3>Eliza Box</h3>
              <p>
                Linux mini PC running the elizaOS live image. One household,
                one agent, always on — plug in HDMI and it boots straight into
                Eliza.
              </p>
              <ul>
                <li>
                  <Check className="os-icon" /> UEFI boot, signed image
                </li>
                <li>
                  <Check className="os-icon" /> Offline first
                </li>
                <li>
                  <Check className="os-icon" /> Web dashboard on :2138
                </li>
              </ul>
            </article>
            <article className="os-hardware-tile">
              <h3>Eliza USB</h3>
              <p>
                Bootable USB live image with encrypted persistence. Carry your
                agent on a keychain and boot it on any UEFI machine.
              </p>
              <ul>
                <li>
                  <Check className="os-icon" /> Encrypted persistent home
                </li>
                <li>
                  <Check className="os-icon" /> SHA-256 verified write
                </li>
                <li>
                  <Check className="os-icon" /> UEFI + Secure Boot ready
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
          <div className="os-footer-right">
            <nav className="os-footer-nav">
              <a href={githubUrl}>GitHub</a>
              <a href={cloudUrl}>Cloud</a>
              <a href={appUrl}>App</a>
              <a href="/docs">Docs</a>
            </nav>
            <div className="os-footer-socials" aria-label="Community">
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
              >
                <span className="sr-only">GitHub</span>
                <svg
                  aria-hidden="true"
                  className="os-social-icon"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  />
                </svg>
              </a>
              <a
                href={discordUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Discord"
              >
                <span className="sr-only">Discord</span>
                <svg
                  aria-hidden="true"
                  className="os-social-icon"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              </a>
              <a
                href={twitterUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="X (Twitter)"
              >
                <span className="sr-only">X</span>
                <svg
                  aria-hidden="true"
                  className="os-social-icon"
                  fill="currentColor"
                  viewBox="0 0 50 50"
                >
                  <path d="M 5.9199219 6 L 20.582031 27.375 L 6.2304688 44 L 9.4101562 44 L 21.986328 29.421875 L 31.986328 44 L 44 44 L 28.681641 21.669922 L 42.199219 6 L 39.029297 6 L 27.275391 19.617188 L 17.933594 6 L 5.9199219 6 z M 9.7167969 8 L 16.880859 8 L 40.203125 42 L 33.039062 42 L 9.7167969 8 z" />
                </svg>
              </a>
            </div>
            <p className="os-footer-copy">© 2026 elizaOS contributors</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
