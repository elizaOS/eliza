import { StewardAuth } from "@stwd/sdk";
import { ArrowRight, CreditCard, Download, ShoppingBag } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type OsArtifact, OsDownloads } from "./components/OsDownloads";

const appUrl = "https://eliza.app";
const cloudUrl = "https://elizacloud.ai/login?intent=launch";
const checkoutBaseUrl = "https://elizaos.ai/checkout";
const cloudApiUrl =
  import.meta.env.VITE_ELIZA_CLOUD_API_URL || "https://api.elizacloud.ai";
const stewardApiUrl = `${cloudApiUrl.replace(/\/$/, "")}/steward`;
const stewardTenantId = "elizacloud";
const betaManifestUrl = "/downloads/elizaos-beta-manifest.json";
const githubUrl = "https://github.com/elizaOS";
const xUrl = "https://x.com/elizaos";

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
  colors: string[];
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
    colors: ["Orange", "Blue", "White", "Black"],
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
    colors: ["Orange", "Blue", "White", "Black"],
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
    colors: ["Orange", "Blue", "White", "Black"],
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
    colors: ["Orange", "Blue", "White", "Black"],
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
    colors: ["Orange", "Blue", "White", "Blue glass"],
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
    colors: ["Orange"],
  },
];

function productCheckoutUrl(sku: string) {
  return `${checkoutBaseUrl}?sku=${sku}`;
}

function getDefaultProduct(): Product {
  return (
    hardwareProducts.find((product) => product.sku === "elizaos-usb") ??
    hardwareProducts[0]
  );
}

function getCheckoutProduct(): Product {
  const sku = new URLSearchParams(window.location.search).get("sku");
  return (
    hardwareProducts.find((product) => product.sku === sku) ??
    getDefaultProduct()
  );
}

function buildCheckoutPath(product: Product) {
  return `/checkout?sku=${encodeURIComponent(product.sku)}`;
}

function buildOAuthUrl(provider: "google" | "discord" | "github") {
  const product = getCheckoutProduct();
  const params = new URLSearchParams({
    redirect_uri: `${window.location.origin}${buildCheckoutPath(product)}`,
    tenant_id: stewardTenantId,
  });
  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}

function getStoredStewardToken() {
  try {
    return localStorage.getItem("steward_session_token");
  } catch {
    return null;
  }
}

async function syncStewardSession(token: string, refreshToken?: string | null) {
  const response = await fetch(`${cloudApiUrl}/api/auth/steward-session`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, refreshToken }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || "Could not sync Eliza Cloud session.");
  }
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

function CloudHero({ children }: { children: ReactNode }) {
  return (
    <section className="band hero-cloud" data-hero="cloud">
      <video
        className="cloud-video"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        poster="/clouds/poster.jpg"
        data-testid="cloud-video"
      >
        <source src="/clouds/clouds_4x_1080p.webm" type="video/webm" />
        <source src="/clouds/clouds_4x_1080p.mp4" type="video/mp4" />
      </video>
      <div className="cloud-scrim" aria-hidden="true" />
      <div className="band-inner hero-cloud-inner">{children}</div>
    </section>
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

function Header({ solid = false }: { solid?: boolean }) {
  return (
    <header className={solid ? "site-header site-header-solid" : "site-header"}>
      <a href="/" className="brand" aria-label="elizaOS home">
        <img
          src={
            solid
              ? "/brand/logos/elizaOS_text_white.svg"
              : "/brand/logos/elizaOS_text_black.svg"
          }
          alt="elizaOS"
          draggable={false}
        />
      </a>
      <nav className="site-nav" aria-label="Product switcher">
        <a href="/#download">Download</a>
        <a href="/#downloads">All downloads</a>
        <a href="/#hardware">Hardware</a>
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
        <a href={githubUrl} aria-label="GitHub">
          GitHub
        </a>
        <a href={xUrl} aria-label="X">
          X
        </a>
      </nav>
      <p className="footer-copy">elizaOS. Local first. Open source.</p>
    </footer>
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

function CheckoutResult({
  success,
  canceled,
}: {
  success?: boolean;
  canceled?: boolean;
}) {
  return (
    <div className="os-shell">
      <Header solid />
      <main>
        <section className="band band-blue checkout-result">
          <div className="band-inner">
            <h1>{success ? "Pre-order received." : "Checkout canceled."}</h1>
            <p>
              {success
                ? "Your ElizaOS hardware order is connected to your Eliza Cloud account."
                : "No payment was completed. You can return to the store when ready."}
            </p>
            <a href="/#hardware" className="button">
              {canceled ? "Return to hardware" : "Back to elizaOS"}
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function CheckoutPage() {
  const [product, setProduct] = useState(getCheckoutProduct);
  const [selectedColor, setSelectedColor] = useState(product.colors[0]);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "syncing" | "email-sent" | "checkout"
  >("idle");
  const [isAuthed, setIsAuthed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const auth = useMemo(
    () =>
      new StewardAuth({ baseUrl: stewardApiUrl, tenantId: stewardTenantId }),
    [],
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const refreshToken = params.get("refreshToken");
    if (!token) {
      setIsAuthed(
        Boolean(getStoredStewardToken()) ||
          document.cookie.includes("steward-authed=1"),
      );
      return;
    }

    setStatus("syncing");
    try {
      localStorage.setItem("steward_session_token", token);
      if (refreshToken) {
        localStorage.setItem("steward_refresh_token", refreshToken);
      }
    } catch {}

    syncStewardSession(token, refreshToken)
      .then(() => {
        setIsAuthed(true);
        params.delete("token");
        params.delete("refreshToken");
        const query = params.toString();
        window.history.replaceState(
          null,
          "",
          query
            ? `${window.location.pathname}?${query}`
            : window.location.pathname,
        );
      })
      .catch((error: unknown) => {
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not sync Eliza Cloud session.",
        );
      })
      .finally(() => setStatus("idle"));
  }, []);

  useEffect(() => {
    setSelectedColor(product.colors[0]);
  }, [product]);

  async function sendMagicLink() {
    if (!email.trim()) {
      setMessage("Enter your email first.");
      return;
    }
    setStatus("syncing");
    setMessage(null);
    try {
      await auth.signInWithEmail(email.trim());
      setStatus("email-sent");
    } catch (error) {
      setStatus("idle");
      setMessage(
        error instanceof Error ? error.message : "Could not send magic link.",
      );
    }
  }

  async function beginCheckout() {
    setStatus("checkout");
    setMessage(null);
    try {
      const stewardToken = getStoredStewardToken();
      const response = await fetch(
        `${cloudApiUrl}/api/stripe/create-checkout-session`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(stewardToken
              ? { Authorization: `Bearer ${stewardToken}` }
              : {}),
          },
          body: JSON.stringify({
            hardwareColor: selectedColor,
            hardwareSku: product.sku,
            returnUrl: "billing",
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        url?: string;
      } | null;

      if (!response.ok || !data?.url) {
        if (response.status === 401) setIsAuthed(false);
        throw new Error(data?.error || "Could not start checkout.");
      }

      window.location.href = data.url;
    } catch (error) {
      setStatus("idle");
      setMessage(
        error instanceof Error ? error.message : "Could not start checkout.",
      );
    }
  }

  return (
    <div className="os-shell">
      <Header solid />
      <main>
        <section className="band band-blue checkout-hero">
          <div className="band-inner checkout-grid">
            <div className="checkout-copy">
              <p className="section-kicker">Pre-order</p>
              <h1>{product.name}</h1>
              <p>{product.detail}</p>
              <div className="detail-meta">
                {product.price ? <strong>{product.price}</strong> : null}
                {product.ships ? <span>{product.ships}</span> : null}
              </div>
            </div>
            <div className="checkout-product-shot">
              <ProductImage product={product} />
            </div>
          </div>
        </section>

        <section className="band band-white checkout-flow">
          <div className="band-inner checkout-grid">
            <div>
              <h2>Checkout on elizaOS.</h2>
              <p className="section-lede">
                Login, customer records, credits, and Stripe payments are
                provided by Eliza Cloud.
              </p>
            </div>
            <div className="checkout-panel">
              <div className="checkout-product-picker">
                {hardwareProducts.map((item) => (
                  <button
                    type="button"
                    key={item.sku}
                    className={
                      item.sku === product.sku
                        ? "picker-item picker-item-active"
                        : "picker-item"
                    }
                    onClick={() => {
                      setProduct(item);
                      window.history.replaceState(
                        null,
                        "",
                        buildCheckoutPath(item),
                      );
                    }}
                  >
                    <span>{item.name}</span>
                    <strong>{item.price ?? "Pre-order"}</strong>
                  </button>
                ))}
              </div>

              <fieldset className="color-row" aria-label="Hardware color">
                {product.colors.map((color) => (
                  <button
                    type="button"
                    key={color}
                    className={
                      selectedColor === color
                        ? "color-swatch color-swatch-active"
                        : "color-swatch"
                    }
                    style={{
                      backgroundColor:
                        color === "Orange"
                          ? "#FF5800"
                          : color.startsWith("Blue")
                            ? "#0B35F1"
                            : color === "Black"
                              ? "#000000"
                              : "#FFFFFF",
                    }}
                    onClick={() => setSelectedColor(color)}
                    aria-label={`Select ${color}`}
                  />
                ))}
              </fieldset>

              {isAuthed ? (
                <button
                  type="button"
                  className="button checkout-button"
                  onClick={beginCheckout}
                  disabled={status === "checkout"}
                >
                  <CreditCard className="icon" />
                  {status === "checkout" ? "Opening Stripe..." : "Pay deposit"}
                </button>
              ) : (
                <div className="login-box">
                  <div className="email-row">
                    <input
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      type="email"
                    />
                    <button
                      type="button"
                      onClick={sendMagicLink}
                      disabled={status === "syncing"}
                    >
                      Email link
                    </button>
                  </div>
                  <div className="oauth-row">
                    <a href={buildOAuthUrl("google")}>Google</a>
                    <a href={buildOAuthUrl("github")}>GitHub</a>
                    <a href={buildOAuthUrl("discord")}>Discord</a>
                  </div>
                </div>
              )}
              {status === "email-sent" ? (
                <p className="checkout-message">Check your inbox.</p>
              ) : null}
              {message ? <p className="checkout-message">{message}</p> : null}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

// Maps a manifest artifact to an OsArtifact for the downloads section.
function manifestToOsArtifacts(manifest: unknown): OsArtifact[] {
  if (!manifest || typeof manifest !== "object") return [];
  const m = manifest as Record<string, unknown>;
  const release = m.release as Record<string, string> | undefined;
  const channel =
    (release?.channel as OsArtifact["channel"] | undefined) ?? "beta";
  const version = release?.version ?? "0.0.0";
  const artifacts = Array.isArray(m.artifacts) ? m.artifacts : [];
  return artifacts.map((artifact: Record<string, unknown>): OsArtifact => {
    const target = artifact.target as Record<string, string> | null;
    const platform = (() => {
      const p = target?.platform ?? "";
      if (/android|cuttlefish/i.test(p)) return "android" as const;
      if (/macos|apple/i.test(p)) return "macos" as const;
      if (/windows|win/i.test(p)) return "windows" as const;
      return "linux" as const;
    })();
    const kind = (() => {
      const k = String(artifact.kind ?? "");
      if (k === "raw-image") return "iso" as const;
      if (k === "vm-image") return "ova" as const;
      if (k === "android-image") return "apk" as const;
      if (k === "usb-installer") return "desktop-app" as const;
      return "iso" as const;
    })();
    return {
      id: String(artifact.id ?? ""),
      label: String(artifact.filename ?? "").replace(/\.zst$|\.zip$/, ""),
      description: String(artifact.notes ?? ""),
      platform,
      kind,
      channel,
      version,
      downloadUrl:
        typeof artifact.downloadUrl === "string" ? artifact.downloadUrl : null,
      checksumUrl: null,
      sizeBytes:
        typeof artifact.sizeBytes === "number" ? artifact.sizeBytes : null,
      sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : null,
      releaseNotesUrl: null,
    };
  });
}

// Static OS artifacts for distribution channels not yet in the manifest.
function staticOsArtifacts(
  channel: OsArtifact["channel"],
  version: string,
): OsArtifact[] {
  return [
    {
      id: `elizaos-linux-live-${channel}`,
      label: "elizaOS Linux Live ISO",
      description:
        "Bootable ISO for USB flashing and bare-metal installs. Flash to an 8 GB+ USB drive with the USB Installer app.",
      platform: "linux",
      kind: "iso",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "8 GB USB drive",
    },
    {
      id: "elizaos-debian-package",
      label: "elizaOS Debian / Ubuntu package",
      description:
        "Install elizaOS on an existing Debian or Ubuntu system via apt.",
      platform: "linux",
      kind: "deb",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
    },
    {
      id: "elizaos-vm-ova",
      label: "elizaOS VM (OVA)",
      description:
        "OVA image for VirtualBox, VMware Fusion, and UTM. Import directly — no flashing required.",
      platform: "cross-platform",
      kind: "ova",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
    },
    {
      id: "elizaos-android-apk",
      label: "elizaOS Android APK",
      description:
        "Sideload elizaOS onto any Android device without AOSP flashing. No unlocked bootloader required.",
      platform: "android",
      kind: "apk",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
    },
    {
      id: "elizaos-usb-installer-macos",
      label: "USB Installer — macOS",
      description:
        "Desktop app for macOS that writes the elizaOS ISO to a USB drive using diskutil and dd with native authorization.",
      platform: "macos",
      kind: "desktop-app",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "8 GB USB drive",
    },
    {
      id: "elizaos-usb-installer-linux",
      label: "USB Installer — Linux",
      description:
        "Desktop app for Linux that writes the elizaOS ISO to a USB drive using lsblk and dd via pkexec.",
      platform: "linux",
      kind: "desktop-app",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "8 GB USB drive",
    },
    {
      id: "elizaos-usb-installer-windows",
      label: "USB Installer — Windows",
      description:
        "Desktop app for Windows that writes the elizaOS ISO to a USB drive using PowerShell disk management.",
      platform: "windows",
      kind: "desktop-app",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "8 GB USB drive",
    },
    {
      id: "elizaos-aosp-flasher-macos",
      label: "AOSP Flasher — macOS",
      description:
        "GUI tool for macOS that detects a connected Pixel via ADB and guides through bootloader unlock and flashing.",
      platform: "macos",
      kind: "desktop-app",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "Android device with unlocked bootloader",
    },
    {
      id: "elizaos-aosp-flasher-linux",
      label: "AOSP Flasher — Linux",
      description:
        "GUI tool for Linux that detects a connected Pixel via ADB and guides through bootloader unlock and flashing.",
      platform: "linux",
      kind: "desktop-app",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "Android device with unlocked bootloader",
    },
    {
      id: "elizaos-aosp-flasher-windows",
      label: "AOSP Flasher — Windows",
      description:
        "GUI tool for Windows that detects a connected Pixel via ADB and guides through bootloader unlock and flashing.",
      platform: "windows",
      kind: "desktop-app",
      channel,
      version,
      downloadUrl: null,
      checksumUrl: null,
      sizeBytes: null,
      sha256: null,
      releaseNotesUrl: null,
      requiresHardware: "Android device with unlocked bootloader",
    },
  ];
}

function useOsArtifacts(manifestUrl: string): OsArtifact[] {
  const [artifacts, setArtifacts] = useState<OsArtifact[]>([]);

  useEffect(() => {
    fetch(manifestUrl)
      .then((res) => res.json())
      .then((manifest: unknown) => {
        const fromManifest = manifestToOsArtifacts(manifest);
        const m = manifest as Record<string, unknown> | null;
        const release = m?.release as Record<string, string> | undefined;
        const channel =
          (release?.channel as OsArtifact["channel"] | undefined) ?? "beta";
        const version = release?.version ?? "0.0.0";
        const manifestIds = new Set(fromManifest.map((a) => a.id));
        const extra = staticOsArtifacts(channel, version).filter(
          (a) => !manifestIds.has(a.id),
        );
        setArtifacts([...fromManifest, ...extra]);
      })
      .catch(() => {
        // Manifest unavailable; show static artifacts.
        setArtifacts(staticOsArtifacts("beta", "2.0.0-beta.2-os.20260516"));
      });
  }, [manifestUrl]);

  return artifacts;
}

function HomePage() {
  const osArtifacts = useOsArtifacts(betaManifestUrl);
  return (
    <div className="os-shell">
      <Header />
      <main>
        <CloudHero>
          <img
            src="/brand/logos/logo_white_bluebg.svg"
            alt=""
            aria-hidden="true"
            className="hero-mark"
            draggable={false}
          />
          <h1>The agentic operating system.</h1>
          <p className="hero-copy">
            Local first. Open source. Runs on your phone, your laptop, a USB
            stick, or a mini PC.
          </p>
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
        </CloudHero>

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
                <pre className="os-code">curl -sSL elizaos.ai/install | sh</pre>
              </a>
              <a href={appUrl} className="install-card">
                <div className="install-card-head">
                  <span>Mac, Windows, Linux</span>
                  <strong>VM launcher</strong>
                </div>
                <pre className="os-code">brew install elizaos</pre>
              </a>
              <a href={betaManifestUrl} className="install-card">
                <div className="install-card-head">
                  <span>Android</span>
                  <strong>APK + AOSP image</strong>
                </div>
                <pre className="os-code">adb install elizaos.apk</pre>
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

        <OsDownloads artifacts={osArtifacts} />

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
  if (window.location.pathname === "/checkout/success") {
    return <CheckoutResult success />;
  }
  if (window.location.pathname === "/checkout/cancel") {
    return <CheckoutResult canceled />;
  }
  if (window.location.pathname === "/checkout") {
    return <CheckoutPage />;
  }

  const match = window.location.pathname.match(/^\/hardware\/([^/]+)\/?$/);
  const product = match
    ? hardwareProducts.find((item) => item.slug === match[1])
    : undefined;

  if (match && product) {
    return <ProductDetail product={product} />;
  }

  return <HomePage />;
}
