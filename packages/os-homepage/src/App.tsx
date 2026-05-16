import { Button } from "@elizaos/ui/button";
import { Card } from "@elizaos/ui/card";
import { ProductSwitcher as SharedProductSwitcher } from "@elizaos/ui/product-switcher";
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

const CLOUD_URL =
  import.meta.env.VITE_ELIZA_CLOUD_URL || "https://elizacloud.ai";
const APP_URL = import.meta.env.VITE_ELIZA_APP_URL || "https://eliza.app";
const OS_URL = import.meta.env.VITE_ELIZA_OS_URL || "https://elizaos.ai";

const productLinks = [
  { label: "ElizaOS", href: OS_URL, active: true },
  { label: "Downloads", href: "#downloads" },
  { label: "Hardware", href: "#hardware" },
  { label: "Docs", href: "https://eliza.how", external: true },
];

const colors = [
  { name: "Orange", value: "var(--accent)" },
  { name: "Blue", value: "var(--info)" },
  { name: "White", value: "var(--os-product-white)" },
  { name: "Black", value: "var(--os-product-black)" },
];

const products = [
  {
    id: "phone",
    slug: "phone",
    name: "ElizaOS Phone",
    price: "$499 deposit",
    status: "Reserve hardware",
    summary:
      "A first-party ElizaOS phone concept for users who want the OS as the everyday mobile device.",
    colors: ["Orange", "Blue", "White", "Blue"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-phone`,
    className: "phone-render",
    Icon: Smartphone,
  },
  {
    id: "box",
    slug: "box",
    name: "ElizaOS Box",
    price: "$299 deposit",
    status: "Reserve dev kit",
    summary:
      "A compact ElizaOS runtime box for home, office, and local agent deployments.",
    colors: ["Orange", "Blue", "White", "Black"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-box`,
    className: "box-render",
    Icon: Boxes,
  },
  {
    id: "usb-chibi",
    slug: "usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    status: "Ships October 2026",
    summary:
      "The character USB installer key for preloaded ElizaOS setup media.",
    colors: ["Orange"],
    href: `${CLOUD_URL}/checkout?sku=elizaos-usb-chibi`,
    className: "chibi-render",
    Icon: Usb,
  },
  {
    id: "usb-plastic",
    slug: "usb",
    name: "Branded USB key",
    price: "$49",
    status: "Ships October 2026",
    summary:
      "A simple branded plastic ElizaOS USB installer key in four colors.",
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
    <SharedProductSwitcher
      activeClassName="active"
      className="product-switcher"
      inactiveClassName="switcher-link"
      items={productLinks.map((link) => ({
        ...link,
        external:
          link.external ||
          (!link.href.startsWith("/") &&
            !link.href.startsWith("#") &&
            !link.href.includes("localhost")),
      }))}
      linkClassName="switcher-link"
    />
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
    <Button
      asChild
      className="cta"
      size="lg"
      variant={variant === "primary" ? "default" : "outline"}
    >
      <a href={href}>
        {children}
        <ArrowRight aria-hidden="true" size={18} />
      </a>
    </Button>
  );
}

function FaceLogo() {
  return <img alt="ElizaOS face logo" src="/assets/elizaos-face.svg" />;
}

function Swatches({ names }: { names: string[] }) {
  const occurrences = new Map<string, number>();

  return (
    <ul aria-label="Available colors" className="swatches">
      {names.map((name) => {
        const occurrence = occurrences.get(name) ?? 0;
        occurrences.set(name, occurrence + 1);
        const color = colors.find((item) => item.name === name) ?? colors[0];
        return (
          <li
            aria-label={name}
            className="swatch"
            key={`${name}-${occurrence}`}
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

  if (className === "phone-render") {
    return (
      <div className="visual phone-render">
        <div className="phone-camera" />
        <div className="phone-screen">
          <FaceLogo />
          <span>elizaOS</span>
        </div>
      </div>
    );
  }

  if (className === "box-render") {
    return (
      <div className="visual box-render">
        <div className="box-shell">
          <FaceLogo />
        </div>
      </div>
    );
  }

  return (
    <div className="visual usb-render">
      <div className="usb-body">
        <FaceLogo />
      </div>
      <div className="usb-plug" />
    </div>
  );
}

function ProductCard({ product }: { product: (typeof products)[number] }) {
  return (
    <Card className="product-card" variant="flat">
      <ProductVisual className={product.className} />
      <div className="product-info">
        <div>
          <h3>{product.name}</h3>
          <p>{product.status}</p>
        </div>
      </div>
      <Swatches names={product.colors} />
      <div className="buy-row">
        <strong>{product.price}</strong>
        <div className="buy-actions">
          <a className="details-link" href={`/hardware/${product.slug}`}>
            Details
          </a>
          <Button asChild size="sm">
            <a href={product.href}>Pre-order</a>
          </Button>
        </div>
      </div>
    </Card>
  );
}

function InstallTile({ tile }: { tile: (typeof installTiles)[number] }) {
  const [Icon, title, body] = tile;

  return (
    <Card className="install-tile" variant="flat">
      <a href="/downloads/elizaos-beta-manifest.json">
        <Icon aria-hidden="true" />
        <span>{title}</span>
        <small>{body}</small>
      </a>
    </Card>
  );
}

function SetupCard({ children }: { children: ReactNode }) {
  return (
    <Card className="setup-card" variant="flat">
      {children}
    </Card>
  );
}

function DownloadOptions() {
  return (
    <section className="download-section" id="downloads">
      <div className="section-heading compact">
        <p>Download ElizaOS</p>
        <h2>Choose the installer for your device.</h2>
      </div>
      <div className="install-strip">
        {installTiles.map((tile) => (
          <InstallTile key={tile[1]} tile={tile} />
        ))}
      </div>
    </section>
  );
}

function HardwarePreorder() {
  return (
    <section className="hardware-section" id="hardware">
      <div className="section-heading compact">
        <p>Pre-order hardware</p>
        <h2>USB key, phone, and Box. Ordered through Eliza Cloud.</h2>
      </div>
      <div className="product-grid">
        {products.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </section>
  );
}

function ProductPage({ product }: { product: (typeof products)[number] }) {
  const { Icon } = product;

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <FaceLogo />
          <span>ElizaOS</span>
        </a>
        <ProductSwitcher />
      </header>
      <section className="product-page">
        <div className="product-page-copy">
          <p className="platform-label">ElizaOS hardware</p>
          <h1>{product.name}</h1>
          <p>{product.summary}</p>
          <Swatches names={product.colors} />
          <div className="hero-actions">
            <CtaLink href={product.href}>
              <Icon aria-hidden="true" size={18} />
              Pre-order in Eliza Cloud
            </CtaLink>
            <CtaLink
              href="/downloads/elizaos-beta-manifest.json"
              variant="secondary"
            >
              <Download aria-hidden="true" size={18} />
              Download beta
            </CtaLink>
          </div>
          <a className="back-link" href="/#hardware">
            Back to hardware
          </a>
        </div>
        <ProductVisual className={product.className} />
      </section>
      <Card className="purchase-flow product-flow" variant="flat">
        <div>
          <Cloud aria-hidden="true" />
          <h2>Checkout continues in Eliza Cloud.</h2>
          <p>
            Cloud owns identity, preorder status, payment handoff, and device
            linking after delivery.
          </p>
        </div>
        <div className="flow-steps">
          {["Sign in", "Choose color", "Pay deposit", "Track order"].map(
            (step) => (
              <span key={step}>
                <Check aria-hidden="true" size={16} />
                {step}
              </span>
            ),
          )}
        </div>
        <CtaLink href={product.href}>Open preorder</CtaLink>
      </Card>
    </main>
  );
}

export function App() {
  const path =
    typeof window === "undefined"
      ? "/"
      : window.location.pathname.replace(/\/$/, "");
  const productSlug = path.startsWith("/hardware/")
    ? path.replace("/hardware/", "")
    : null;
  const productPage = productSlug
    ? products.find((product) => product.slug === productSlug)
    : null;

  if (productPage) {
    return <ProductPage product={productPage} />;
  }

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
            Download the beta installer today. Run ElizaOS on a PC, in a VM, on
            Android, or from raw image media.
          </p>
          <div className="hero-actions">
            <CtaLink href="#downloads">
              <Download aria-hidden="true" size={18} />
              Download ElizaOS
            </CtaLink>
            <CtaLink href="#hardware" variant="secondary">
              <Palette aria-hidden="true" size={18} />
              Pre-order hardware
            </CtaLink>
          </div>
          <nav className="sub-ctas" aria-label="Related Eliza products">
            <a href={APP_URL}>Download Eliza App</a>
            <a href={CLOUD_URL}>Run in Eliza Cloud</a>
          </nav>
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
          <div className="hero-product hero-phone">
            <ProductVisual className="phone-render" />
          </div>
          <div className="hero-product hero-box">
            <ProductVisual className="box-render" />
          </div>
          <div className="hero-product hero-usb">
            <ProductVisual className="usb-render" />
          </div>
        </div>
      </section>

      <DownloadOptions />

      <HardwarePreorder />

      <Card className="purchase-flow" variant="flat">
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
      </Card>

      <section className="setup-section">
        <SetupCard>
          <HardDriveDownload aria-hidden="true" />
          <h3>Make your own USB</h3>
          <p>
            Download the beta installer, select a removable drive, verify,
            write, boot.
          </p>
        </SetupCard>
        <SetupCard>
          <MonitorCog aria-hidden="true" />
          <h3>Run the VM</h3>
          <p>Use the bundled launcher on macOS, Windows, or Linux hosts.</p>
        </SetupCard>
        <SetupCard>
          <Smartphone aria-hidden="true" />
          <h3>Flash Android</h3>
          <p>ADB discovery, guided flashing, and post-install validation.</p>
        </SetupCard>
        <SetupCard>
          <ShieldCheck aria-hidden="true" />
          <h3>Verify install</h3>
          <p>Checksums, removable-drive guards, and boot health checks.</p>
        </SetupCard>
      </section>
    </main>
  );
}
