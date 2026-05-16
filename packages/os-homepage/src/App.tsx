import { ArrowRight, Download, ShoppingBag } from "lucide-react";

const appUrl = "https://eliza.app";
const cloudUrl = "https://elizaos.ai/cloud";
const discordUrl = "https://discord.gg/eliza";
const twitterUrl = "https://x.com/elizaos";
const githubUrl = "https://github.com/elizaOS/eliza";
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
  },
  {
    slug: "case",
    sku: "elizaos-raspberry-pi-case",
    name: "Raspberry Pi case",
    price: "$49",
    ships: "Ships October 2026",
    image: "/assets/elizaos-box-concept.avif",
    imageAlt: "ElizaOS Raspberry Pi case concept",
    summary: "A small shell for a local agent.",
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
  },
  {
    slug: "mini-pc",
    sku: "elizaos-mini-pc",
    name: "ElizaOS mini PC",
    price: "$1999",
    ships: "Ships October 2026",
    image: "/assets/concept_minipc.jpg",
    imageAlt: "ElizaOS mini PC concept",
    summary: "Always-on home compute for agents.",
  },
  {
    slug: "phone",
    sku: "elizaos-phone",
    name: "ElizaOS Phone",
    ships: "Pre-order",
    image: "/assets/concept_phone.jpg",
    imageAlt: "ElizaOS phone concept",
    summary: "The app and runtime in one device.",
  },
  {
    slug: "box",
    sku: "elizaos-box",
    name: "ElizaOS Box",
    ships: "Pre-order",
    image: "/assets/billboard_concept.jpg",
    imageAlt: "ElizaOS box campaign concept",
    summary: "A household agent appliance.",
  },
  {
    slug: "chibi-usb",
    sku: "elizaos-usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    ships: "Ships October 2026",
    image: "/assets/chibi_usb_concept.jpg",
    imageAlt: "Chibi ElizaOS USB key concept",
    summary: "A tiny boot key with a mascot shell.",
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

function ProductRows() {
  return (
    <div className="product-rows">
      {hardwareProducts.map((product, index) => (
        <article className="product-row" key={product.sku}>
          <a href={`/hardware/${product.slug}`} className="product-media">
            <ProductImage product={product} />
          </a>
          <div className="product-copy">
            <p className="section-kicker">
              {product.price ? product.price : "Hardware"}
            </p>
            <h3>{product.name}</h3>
            <p>{product.summary}</p>
          </div>
          <div className="product-actions">
            {product.ships ? <span>{product.ships}</span> : null}
            <a
              href={productCheckoutUrl(product.sku)}
              className={index % 2 === 0 ? "button button-dark" : "button"}
            >
              Pre-order
            </a>
          </div>
        </article>
      ))}
    </div>
  );
}

function ProductDetail({ product }: { product: Product }) {
  return (
    <div className="os-shell">
      <Header />
      <main>
        <section className="band band-blue product-detail-hero">
          <div className="band-inner detail-grid">
            <div>
              <a href="/#hardware" className="text-link">
                Hardware
              </a>
              <h1>{product.name}</h1>
              <p>{product.summary}</p>
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
              <p className="detail-note">
                Checkout stays on elizaos.ai. Beta downloads stay open.
              </p>
            </div>
            <ProductImage product={product} />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="site-header">
      <a href="/" className="brand" aria-label="elizaOS home">
        <img
          src="/brand/logos/elizaOS_text_white.svg"
          alt="elizaOS"
          draggable={false}
        />
      </a>
      <nav className="site-nav" aria-label="Product switcher">
        <a href="#downloads">Download</a>
        <a href="#hardware">Hardware</a>
        <a href={githubUrl}>GitHub</a>
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
        <a href={githubUrl}>GitHub</a>
        <a href={discordUrl}>Discord</a>
        <a href={twitterUrl}>X</a>
        <a href={appUrl}>App</a>
      </nav>
    </footer>
  );
}

function HomePage() {
  return (
    <div className="os-shell">
      <Header />
      <main>
        <section className="band band-blue hero-band">
          <div className="band-inner hero-layout">
            <div>
              <p className="section-kicker">elizaOS</p>
              <h1>
                The agentic operating system for devices that run themselves.
              </h1>
              <p className="hero-copy">
                Install the runtime. Boot the hardware.
              </p>
              <div className="hero-actions">
                <a href="#downloads" className="button">
                  Download/install elizaOS
                  <Download className="icon" />
                </a>
                <a href="#hardware" className="button button-dark">
                  Pre-order hardware
                  <ShoppingBag className="icon" />
                </a>
              </div>
            </div>
            <img
              src="/assets/billboard_concept.jpg"
              alt="elizaOS hardware campaign"
              className="hero-image"
              draggable={false}
            />
          </div>
        </section>

        <section id="downloads" className="band band-white">
          <div className="band-inner split-band">
            <div>
              <p className="section-kicker">Download</p>
              <h2>Choose the installer for your device.</h2>
            </div>
            <div className="download-stack">
              <a href={betaManifestUrl} className="download-line">
                <span>Download ElizaOS</span>
                <strong>Beta manifest</strong>
              </a>
              <a href={appUrl} className="download-line">
                <span>Download Eliza App</span>
                <strong>iOS + Android</strong>
              </a>
              <a href={cloudUrl} className="download-line">
                <span>Run in Eliza Cloud</span>
                <strong>Managed runtime</strong>
              </a>
            </div>
          </div>
        </section>

        <section className="band band-orange">
          <div className="band-inner punch-band">
            <h2>Local first. Cloud when you want it.</h2>
            <p>Supported Mac hardware is limited during beta.</p>
          </div>
        </section>

        <section id="hardware" className="band band-black">
          <div className="band-inner">
            <div className="section-head">
              <p className="section-kicker">Store</p>
              <h2>Pre-order hardware on elizaos.ai.</h2>
              <a
                href={`${checkoutBaseUrl}?collection=elizaos-hardware`}
                className="button"
              >
                Open checkout
                <ArrowRight className="icon" />
              </a>
            </div>
            <ProductRows />
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
