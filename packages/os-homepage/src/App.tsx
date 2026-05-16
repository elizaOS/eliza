import { ArrowRight, Download, ShoppingBag } from "lucide-react";

const appUrl = "https://eliza.app";
const cloudUrl = "https://elizacloud.ai/login?intent=launch";
const checkoutBaseUrl = "https://elizaos.ai/checkout";
const betaManifestUrl = "/downloads/elizaos-beta-manifest.json";

type Product = {
  slug: string;
  sku: string;
  name: string;
  price?: string;
  ships?: string;
  image: string;
  imageAlt: string;
  summary: string;
  detail: string;
};

const hardwareProducts: Product[] = [
  {
    slug: "usb",
    sku: "elizaos-usb",
    name: "ElizaOS USB",
    price: "$49",
    ships: "Ships October 2026",
    image: "/assets/concept_usbdrive.jpg",
    imageAlt: "Blue ElizaOS USB drive concept",
    summary: "Boot elizaOS from your pocket.",
    detail: "Live image on a stick. Plug into any UEFI PC and run.",
  },
  {
    slug: "case",
    sku: "elizaos-raspberry-pi-case",
    name: "Raspberry Pi case",
    price: "$49",
    ships: "Ships October 2026",
    image: "/assets/elizaos-box-concept.avif",
    imageAlt: "ElizaOS Raspberry Pi case concept",
    summary: "A shell for a local agent.",
    detail: "Bring your own Pi. We ship the enclosure.",
  },
  {
    slug: "raspberry-pi",
    sku: "elizaos-custom-raspberry-pi-case",
    name: "Custom Raspberry Pi + case",
    price: "$149",
    ships: "Ships October 2026",
    image: "/assets/elizaos-box-concept.avif",
    imageAlt: "ElizaOS Raspberry Pi kit concept",
    summary: "Plug in, boot, run local.",
    detail: "Pi, case, SD card pre-imaged. One box, one cable.",
  },
  {
    slug: "mini-pc",
    sku: "elizaos-mini-pc",
    name: "ElizaOS mini PC",
    price: "$1999",
    ships: "Ships October 2026",
    image: "/assets/concept_minipc.jpg",
    imageAlt: "ElizaOS mini PC concept",
    summary: "Always-on compute for agents.",
    detail: "Desktop-class inference at home. Quiet, owned, yours.",
  },
  {
    slug: "phone",
    sku: "elizaos-phone",
    name: "ElizaOS Phone",
    ships: "Pre-order",
    image: "/assets/concept_phone.jpg",
    imageAlt: "ElizaOS phone concept",
    summary: "The runtime in your hand.",
    detail: "AOSP build with elizaOS as the shell.",
  },
  {
    slug: "chibi-usb",
    sku: "elizaos-usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    ships: "Ships October 2026",
    image: "/assets/chibi_usb_concept.jpg",
    imageAlt: "Chibi ElizaOS USB key concept",
    summary: "Same boot key. Smaller mascot shell.",
    detail: "ElizaOS USB in a collector enclosure.",
  },
];

function productCheckoutUrl(sku: string) {
  return `${checkoutBaseUrl}?sku=${sku}`;
}

function ProductImage({ product }: { product: Product }) {
  return (
    <img
      src={product.image}
      alt={product.imageAlt}
      className="product-image"
      draggable={false}
    />
  );
}

function FeaturedUsbCard() {
  const usb = hardwareProducts.find((p) => p.slug === "usb");
  if (!usb) return null;
  return (
    <a href={`/hardware/${usb.slug}`} className="hw-featured">
      <div className="hw-featured-media">
        <ProductImage product={usb} />
      </div>
      <div className="hw-featured-body">
        <span className="hw-featured-kicker">Pre-order</span>
        <h3>{usb.name}</h3>
        <p>{usb.detail}</p>
        <div className="hw-featured-meta">
          {usb.price ? <strong>{usb.price}</strong> : null}
          {usb.ships ? <span>{usb.ships}</span> : null}
        </div>
        <span className="hw-featured-cta">
          Reserve a USB
          <ArrowRight className="icon" />
        </span>
      </div>
    </a>
  );
}

function HardwareTiles() {
  return (
    <div className="hw-grid">
      {hardwareProducts.map((product) => (
        <a
          key={product.sku}
          href={`/hardware/${product.slug}`}
          className="hw-tile"
        >
          <ProductImage product={product} />
          <div className="hw-tile-body">
            <div className="hw-tile-meta">
              <span>{product.price ?? "Pre-order"}</span>
              {product.ships ? <span>{product.ships}</span> : null}
            </div>
            <h3>{product.name}</h3>
            <p>{product.summary}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

function ProductDetail({ product }: { product: Product }) {
  return (
    <div className="os-shell">
      <Header solid />
      <main>
        <section className="band band-blue product-detail-hero">
          <div className="band-inner detail-grid">
            <div>
              <a href="/#hardware" className="text-link">
                Hardware
              </a>
              <h1>{product.name}</h1>
              <p>{product.summary}</p>
              <p className="detail-extra">{product.detail}</p>
              <div className="detail-meta">
                {product.price ? <strong>{product.price}</strong> : null}
                {product.ships ? <span>{product.ships}</span> : null}
              </div>
              <div className="hero-actions">
                <a href={productCheckoutUrl(product.sku)} className="button">
                  Pre-order on elizaos.ai
                  <ArrowRight className="icon" />
                </a>
                <a href={betaManifestUrl} className="button button-dark">
                  Download beta
                  <Download className="icon" />
                </a>
              </div>
              <p className="detail-note">Checkout stays on elizaos.ai.</p>
            </div>
            <ProductImage product={product} />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function Header({ solid = false }: { solid?: boolean }) {
  return (
    <header className={solid ? "site-header site-header-solid" : "site-header"}>
      <a href="/" className="brand" aria-label="elizaOS home">
        <img
          src="/brand/logos/elizaOS_text_white.svg"
          alt="elizaOS"
          draggable={false}
        />
      </a>
      <nav className="site-nav" aria-label="Product switcher">
        <a href="#download">Download</a>
        <a href="#hardware">Hardware</a>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <img
        src="/brand/logos/elizaOS_text_white.svg"
        alt="elizaOS"
        draggable={false}
      />
      <nav aria-label="Community">
        <a href={appUrl}>App</a>
        <a href={cloudUrl}>Cloud</a>
      </nav>
    </footer>
  );
}

function HomePage() {
  return (
    <div className="os-shell">
      <Header />
      <main>
        <section className="band band-blue hero-os">
          <div className="band-inner hero-os-inner">
            <img
              src="/brand/logos/logo_white_bluebg.svg"
              alt=""
              aria-hidden="true"
              className="hero-mark"
              draggable={false}
            />
            <h1>The agentic operating system.</h1>
            <p className="hero-copy">For devices that run themselves.</p>
            <div className="hero-actions">
              <a href="#download" className="button">
                Download
                <Download className="icon" />
              </a>
              <a href="#hardware" className="button button-dark">
                Hardware
                <ShoppingBag className="icon" />
              </a>
            </div>
          </div>
        </section>

        <section id="download" className="band band-white">
          <div className="band-inner split-band">
            <div>
              <h2>Install elizaOS.</h2>
              <p className="section-lede">Pick a target. Boot.</p>
            </div>
            <div className="install-stack">
              <a href={betaManifestUrl} className="install-card">
                <div className="install-card-head">
                  <span>Linux PC</span>
                  <strong>ISO + USB installer</strong>
                </div>
              </a>
              <a href={appUrl} className="install-card">
                <div className="install-card-head">
                  <span>Mac, Windows, Linux</span>
                  <strong>VM launcher</strong>
                </div>
              </a>
              <a href={betaManifestUrl} className="install-card">
                <div className="install-card-head">
                  <span>Android</span>
                  <strong>APK + AOSP image</strong>
                </div>
              </a>
            </div>
          </div>
        </section>

        <section className="band band-orange">
          <div className="band-inner punch-band">
            <h2>Local first.</h2>
            <p>
              Your agent runs on your device. No account required. Supported Mac
              hardware is limited.
            </p>
          </div>
        </section>

        <section id="hardware" className="band band-blue">
          <div className="band-inner">
            <div className="section-head">
              <h2>Hardware.</h2>
              <a
                href={`${checkoutBaseUrl}?collection=elizaos-hardware`}
                className="button button-dark"
              >
                Open checkout
                <ArrowRight className="icon" />
              </a>
            </div>
            <FeaturedUsbCard />
            <HardwareTiles />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

export function App() {
  const match = window.location.pathname.match(/^\/hardware\/([^/]+)\/?$/);
  const product = match
    ? hardwareProducts.find((item) => item.slug === match[1])
    : undefined;

  if (match && product) {
    return <ProductDetail product={product} />;
  }

  return <HomePage />;
}
