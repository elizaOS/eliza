import {
  ArrowRight,
  Boxes,
  Check,
  Cloud,
  Download,
  HardDriveDownload,
  Laptop,
  MonitorCog,
  Palette,
  ShieldCheck,
  Smartphone,
  Usb,
} from "lucide-react";
import type { ReactNode } from "react";

const CLOUD_URL = "https://elizacloud.ai";

const productLinks = [
  { label: "ElizaOS", href: "https://elizaos.ai", active: true },
  { label: "App", href: "https://eliza.app" },
  { label: "Cloud", href: CLOUD_URL },
  { label: "Docs", href: "https://docs.elizaos.ai" },
  { label: "GitHub", href: "https://github.com/elizaOS/eliza" },
];

const colors = [
  { name: "Orange", value: "#ff5800" },
  { name: "Blue", value: "#0057ff" },
  { name: "White", value: "#f8f8f5" },
  { name: "Black", value: "#111111" },
];

const products = [
  {
    id: "phone",
    name: "ElizaOS Phone",
    price: "$499 deposit",
    status: "Reserve hardware",
    colors: ["Orange", "Blue", "White", "Blue"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-phone`,
    className: "phone-render",
    Icon: Smartphone,
  },
  {
    id: "box",
    name: "ElizaOS Box",
    price: "$299 deposit",
    status: "Reserve dev kit",
    colors: ["Orange", "Blue", "White", "Black"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-box`,
    className: "box-render",
    Icon: Boxes,
  },
  {
    id: "usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    status: "Ships October 2026",
    colors: ["Orange"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-usb-chibi`,
    className: "chibi-render",
    Icon: Usb,
  },
  {
    id: "usb-plastic",
    name: "Branded USB key",
    price: "$49",
    status: "Ships October 2026",
    colors: ["Orange", "Blue", "White", "Black"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-usb-plastic`,
    className: "usb-render",
    Icon: Usb,
  },
];

const installTiles = [
  [Laptop, "PC native", "ISO + USB installer"],
  [MonitorCog, "VM launcher", "macOS, Windows, Linux"],
  [Smartphone, "Android", "ADB guided beta"],
  [Download, "Raw image", "Checksum manifest"],
] as const;

function ProductSwitcher() {
  return (
    <nav className="product-switcher" aria-label="Product switcher">
      {productLinks.map((link) => (
        <a
          className={link.active ? "switcher-link active" : "switcher-link"}
          href={link.href}
          key={link.label}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
}

function CtaLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <a className={`cta ${variant}`} href={href}>
      {children}
      <ArrowRight aria-hidden="true" size={18} />
    </a>
  );
}

function FaceLogo() {
  return <img alt="ElizaOS face logo" src="/assets/elizaos-face.svg" />;
}

function Swatches({ names }: { names: string[] }) {
  return (
    <ul aria-label="Available colors" className="swatches">
      {names.map((name) => {
        const color = colors.find((item) => item.name === name) ?? colors[0];
        return (
          <li
            aria-label={name}
            className="swatch"
            key={name}
            style={{ background: color.value }}
            title={name}
          />
        );
      })}
    </ul>
  );
}

function ProductVisual({ className }: { className: string }) {
  if (className === "chibi-render") {
    return (
      <div className="visual chibi-render">
        <img
          alt="Chibi ElizaOS USB key concept"
          src="/assets/elizaos-usb-key-concept.png"
        />
      </div>
    );
  }

  if (className === "box-render") {
    return (
      <div className="visual box-render">
        <img alt="Orange ElizaOS Box concept" src="/assets/elizaos-box-concept.avif" />
        <span className="brand-mark">Box</span>
      </div>
    );
  }

  return (
    <div className={`visual ${className}`}>
      <div className="device-face">
        <FaceLogo />
      </div>
      <span className="brand-mark">elizaOS</span>
    </div>
  );
}

export function App() {
  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <FaceLogo />
          <span>ElizaOS</span>
        </a>
        <ProductSwitcher />
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="platform-label">ElizaOS hardware + operating system</p>
          <h1>The agentic operating system for devices that run themselves.</h1>
          <p className="hero-subtitle">
            Buy first-party ElizaOS hardware through Eliza Cloud, or download
            the beta installer and make your own USB today.
          </p>
          <div className="hero-actions">
            <CtaLink href="#hardware">
              <Palette aria-hidden="true" size={18} />
              Shop hardware
            </CtaLink>
            <CtaLink
              href="/downloads/elizaos-beta-manifest.json"
              variant="secondary"
            >
              <Download aria-hidden="true" size={18} />
              Download beta
            </CtaLink>
          </div>
          <p className="hardware-warning">
            Supported Mac hardware is limited. Apple Silicon support currently
            targets selected M1/M2 devices. Newer Macs may not be supported.
          </p>
        </div>

        <div
          aria-label="ElizaOS hardware colors"
          className="hero-showcase"
          role="img"
        >
          <div className="phone-render hero-phone">
            <div className="device-face">
              <FaceLogo />
            </div>
            <span className="brand-mark">elizaOS</span>
          </div>
          <div className="box-render hero-box">
            <div className="device-face">
              <FaceLogo />
            </div>
            <span className="brand-mark">Box</span>
          </div>
          <div className="usb-render hero-usb">
            <div className="device-face">
              <FaceLogo />
            </div>
            <span className="brand-mark">USB</span>
          </div>
        </div>
      </section>

      <section className="hardware-section" id="hardware">
        <div className="section-heading compact">
          <p>Eliza Cloud checkout</p>
          <h2>Pick the device. Pick the color. Buy with your Eliza account.</h2>
        </div>
        <div className="product-grid">
          {products.map(({ Icon, ...product }) => (
            <article className="product-card" key={product.id}>
              <ProductVisual className={product.className} />
              <div className="product-info">
                <Icon aria-hidden="true" />
                <div>
                  <h3>{product.name}</h3>
                  <p>{product.status}</p>
                </div>
              </div>
              <Swatches names={product.colors} />
              <div className="buy-row">
                <strong>{product.price}</strong>
                <a href={product.href}>Buy in Cloud</a>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="install-strip" id="downloads">
        {installTiles.map(([Icon, title, body]) => (
          <a
            className="install-tile"
            href="/downloads/elizaos-beta-manifest.json"
            key={title}
          >
            <Icon aria-hidden="true" />
            <span>{title}</span>
            <small>{body}</small>
          </a>
        ))}
      </section>

      <section className="purchase-flow">
        <div>
          <Cloud aria-hidden="true" />
          <h2>Hardware orders live in Eliza Cloud.</h2>
          <p>
            Cloud handles checkout, order status, account identity, device
            linking, and installer downloads.
          </p>
        </div>
        <div className="flow-steps">
          {[
            "Sign in",
            "Choose hardware",
            "Pick color",
            "Pay deposit",
            "Link device",
          ].map((step) => (
            <span key={step}>
              <Check aria-hidden="true" size={16} />
              {step}
            </span>
          ))}
        </div>
        <CtaLink href={`${CLOUD_URL}/checkout?collection=elizaos-hardware`}>
          Open Cloud checkout
        </CtaLink>
      </section>

      <section className="setup-section">
        <article>
          <HardDriveDownload aria-hidden="true" />
          <h3>Make your own USB</h3>
          <p>
            Download the beta installer, select a removable drive, verify,
            write, boot.
          </p>
        </article>
        <article>
          <MonitorCog aria-hidden="true" />
          <h3>Run the VM</h3>
          <p>Use the bundled launcher on macOS, Windows, or Linux hosts.</p>
        </article>
        <article>
          <Smartphone aria-hidden="true" />
          <h3>Flash Android</h3>
          <p>ADB discovery, guided flashing, and post-install validation.</p>
        </article>
        <article>
          <ShieldCheck aria-hidden="true" />
          <h3>Verify install</h3>
          <p>Checksums, removable-drive guards, and boot health checks.</p>
        </article>
      </section>
    </main>
  );
}
