import { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  HARDWARE_PRODUCTS as hardwareProducts,
  type Product,
} from "@elizaos/shared/hardware-catalog";
import { CloudVideoBackground } from "@elizaos/ui";
import { ArrowRight, Download, ShoppingBag } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";

const CheckoutPage = lazy(() =>
  import("./CheckoutPage").then((module) => ({ default: module.CheckoutPage })),
);
const CheckoutResult = lazy(() =>
  import("./CheckoutPage").then((module) => ({
    default: module.CheckoutResult,
  })),
);
const ProductDetail = lazy(() =>
  import("./ProductDetail").then((module) => ({
    default: module.ProductDetail,
  })),
);

const appUrl = EXTERNAL_URLS.app;
const cloudUrl = `${EXTERNAL_URLS.cloud}/login?intent=launch`;
const betaManifestUrl = "/downloads/elizaos-beta-manifest.json";
const checkoutPath = "/checkout";

type ReleaseArtifact = {
  id: string;
  label: string;
  kind: string;
  platform: string;
  architecture: string;
  url: string;
  checksumUrl?: string;
};

type ReleaseManifest = {
  product: string;
  channel: string;
  availableFrom: string;
  artifacts: ReleaseArtifact[];
};

const releaseFallback: ReleaseManifest = {
  product: "ElizaOS",
  channel: "beta",
  availableFrom: "2026-05-16",
  artifacts: [
    {
      id: "elizaos-live-beta-x86_64",
      label: "ElizaOS Linux live beta",
      kind: "raw-image",
      platform: "linux-bare-metal",
      architecture: "x86_64",
      url: "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/eliza-canary-linux-x64.tar.zst",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/SHA256SUMS.txt",
    },
    {
      id: "elizaos-usb-installer-windows-x86_64",
      label: "ElizaOS USB installer for Windows",
      kind: "usb-installer",
      platform: "windows",
      architecture: "x86_64",
      url: "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/eliza-canary-windows-x64.exe.zip",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/SHA256SUMS.txt",
    },
    {
      id: "elizaos-vm-macos-silicon",
      label: "ElizaOS VM launcher for Apple Silicon",
      kind: "vm-bundle",
      platform: "macos",
      architecture: "arm64",
      url: "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/eliza-canary-macos-arm64.app.tar.gz",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/SHA256SUMS.txt",
    },
    {
      id: "elizaos-android-beta",
      label: "ElizaOS Android beta image bundle",
      kind: "android-image",
      platform: "android",
      architecture: "arm64",
      url: "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/elizaos-android-2.0.0-beta.2-release.apk",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/v2.0.0-beta.2/SHA256SUMS.txt",
    },
  ],
};

function ProductImage({
  product,
  priority = false,
}: {
  product: Product;
  priority?: boolean;
}) {
  return (
    <img
      src={product.image}
      alt={product.imageAlt}
      className="product-image"
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "low"}
      draggable={false}
    />
  );
}

function platformLabel(platform: string) {
  return platform
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function ReleaseDownloads() {
  const [manifest, setManifest] = useState<ReleaseManifest>(releaseFallback);

  useEffect(() => {
    let ignore = false;

    fetch(betaManifestUrl)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ReleaseManifest | null) => {
        if (!ignore && data?.artifacts?.length) {
          setManifest(data);
        }
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, []);

  const releaseDate = new Date(
    `${manifest.availableFrom}T00:00:00`,
  ).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <section id="download" className="band band-white release-section">
      <div className="band-inner">
        <div className="release-head">
          <div>
            <p className="section-kicker">
              {manifest.product} {manifest.channel}
            </p>
            <h2>Download beta.</h2>
          </div>
          <p className="section-lede">Available {releaseDate}.</p>
        </div>

        <div className="release-grid">
          {manifest.artifacts.map((artifact) => (
            <article className="release-item" key={artifact.id}>
              <div className="release-meta">
                <span>{platformLabel(artifact.platform)}</span>
                <span>{artifact.architecture}</span>
              </div>
              <h3>{artifact.label}</h3>
              <div className="release-actions">
                <a href={artifact.url} className="button button-dark">
                  Download
                  <Download className="icon" />
                </a>
                {artifact.checksumUrl ? (
                  <a href={artifact.checksumUrl} className="checksum-link">
                    SHA256
                  </a>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function CloudHero({ children }: { children: ReactNode }) {
  return (
    <section className="band hero-cloud" data-hero="cloud">
      <CloudVideoBackground
        className="cloud-background"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
        }}
      />
      <div className="cloud-scrim" aria-hidden="true" />
      <div className="band-inner hero-cloud-inner">{children}</div>
    </section>
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

function Header({ solid = false }: { solid?: boolean }) {
  return (
    <header className={solid ? "site-header site-header-solid" : "site-header"}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[color:var(--brand-orange)]"
      >
        Skip to content
      </a>
      <a href="/" className="brand" aria-label="elizaOS home">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
          alt="elizaOS"
          draggable={false}
        />
      </a>
      <nav className="site-nav" aria-label="Product switcher">
        <a href="/#download">Download</a>
        <a href="/#hardware">Hardware</a>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <img
        src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
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
      <main id="main">
        <CloudHero>
          <h1>The agentic operating system.</h1>
          <p className="hero-copy">For devices that run themselves.</p>
          <div className="hero-actions">
            <a href="#download" className="button button-dark">
              Download
              <Download className="icon" />
            </a>
            <a href="#hardware" className="button">
              Hardware
              <ShoppingBag className="icon" />
            </a>
          </div>
        </CloudHero>

        <ReleaseDownloads />

        <section id="hardware" className="band band-blue">
          <div className="band-inner">
            <div className="section-head">
              <h2>Hardware.</h2>
              <a
                href={`${checkoutPath}?collection=elizaos-hardware`}
                className="button button-dark"
              >
                Open checkout
                <ArrowRight className="icon" />
              </a>
            </div>
            <HardwareTiles />
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function RouteFallback() {
  return (
    <div
      className="os-shell"
      style={{
        minHeight: "100vh",
        background: "var(--brand-blue, #0066ff)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        aria-label="Loading"
        role="status"
        style={{
          width: 32,
          height: 32,
          border: "3px solid rgba(255,255,255,0.3)",
          borderTopColor: "#fff",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function App() {
  if (window.location.pathname === "/checkout/success") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <CheckoutResult success />
      </Suspense>
    );
  }
  if (window.location.pathname === "/checkout/cancel") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <CheckoutResult canceled />
      </Suspense>
    );
  }
  if (window.location.pathname === "/checkout") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <CheckoutPage />
      </Suspense>
    );
  }

  const match = window.location.pathname.match(/^\/hardware\/([^/]+)\/?$/);
  const product = match
    ? hardwareProducts.find((item) => item.slug === match[1])
    : undefined;

  if (match && product) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <ProductDetail product={product} />
      </Suspense>
    );
  }

  return <HomePage />;
}
