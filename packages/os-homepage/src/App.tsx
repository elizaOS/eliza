import {
  StripeCheckoutError,
  startStripeCheckout,
} from "@elizaos/checkout-shared";
import {
  HARDWARE_PRODUCTS as hardwareProducts,
  type Product,
} from "@elizaos/hardware-catalog";
import {
  BRAND_COLORS,
  BRAND_PATHS,
  EXTERNAL_URLS,
  LOGO_FILES,
} from "@elizaos/shared-brand";
import {
  exchangeStewardCode,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TENANT_ID,
  syncStewardSession,
  writeStoredStewardRefreshToken,
  writeStoredStewardToken,
} from "@elizaos/steward-session-client";
import { CloudVideoBackground } from "@elizaos/ui";
import { StewardAuth } from "@stwd/sdk";
import { ArrowRight, CreditCard, Download, ShoppingBag } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

const appUrl = EXTERNAL_URLS.app;
const cloudUrl = `${EXTERNAL_URLS.cloud}/login?intent=launch`;
const checkoutBaseUrl = `${EXTERNAL_URLS.os}/checkout`;
const cloudApiUrl =
  import.meta.env.VITE_ELIZA_CLOUD_API_URL || "https://api.elizacloud.ai";
const stewardApiUrl = `${cloudApiUrl.replace(/\/$/, "")}/steward`;
const stewardTenantId = STEWARD_TENANT_ID;
const betaManifestUrl = "/downloads/elizaos-beta-manifest.json";

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
      url: "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/elizaos-live-beta-x86_64.img.zst",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/SHA256SUMS",
    },
    {
      id: "elizaos-usb-installer-windows-x86_64",
      label: "ElizaOS USB installer for Windows",
      kind: "usb-installer",
      platform: "windows",
      architecture: "x86_64",
      url: "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/elizaos-usb-installer-beta-windows-x86_64.exe",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/SHA256SUMS",
    },
    {
      id: "elizaos-vm-macos-silicon",
      label: "ElizaOS VM launcher for Apple Silicon",
      kind: "vm-bundle",
      platform: "macos",
      architecture: "arm64",
      url: "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/elizaos-vm-macos-silicon.zip",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/SHA256SUMS",
    },
    {
      id: "elizaos-android-beta",
      label: "ElizaOS Android beta image bundle",
      kind: "android-image",
      platform: "android",
      architecture: "arm64",
      url: "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/elizaos-android-beta.zip",
      checksumUrl:
        "https://github.com/elizaOS/eliza/releases/download/elizaos-beta/SHA256SUMS",
    },
  ],
};

function productCheckoutUrl(sku: string) {
  return `${checkoutBaseUrl}?sku=${sku}`;
}

function getDefaultProduct(): Product {
  const fallback =
    hardwareProducts.find((product) => product.sku === "elizaos-usb") ??
    hardwareProducts[0];
  if (!fallback) throw new Error("Hardware catalog is empty");
  return fallback;
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

/**
 * Build the redirect_uri we hand to Steward. Kept as a single function so the
 * value we send at /authorize time exactly matches the value we send at
 * /exchange time — Steward rejects the exchange if they differ.
 */
function buildOAuthRedirectUri(product: Product): string {
  return `${window.location.origin}${buildCheckoutPath(product)}`;
}

function buildOAuthUrl(provider: "google" | "discord" | "github") {
  const product = getCheckoutProduct();
  const params = new URLSearchParams({
    redirect_uri: buildOAuthRedirectUri(product),
    tenant_id: stewardTenantId,
    // Opt into the nonce-exchange flow: Steward redirects back with
    // `?code=<nonce>` (no tokens in the URL) and we trade the code for
    // tokens server-side via /api/auth/steward-nonce-exchange.
    response_type: "code",
  });
  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}

function getStoredStewardToken() {
  return readStoredStewardToken();
}

const stewardSessionEndpoint = `${cloudApiUrl.replace(/\/$/, "")}${STEWARD_SESSION_ENDPOINT}`;
const stewardNonceExchangeEndpoint = `${cloudApiUrl.replace(/\/$/, "")}${STEWARD_NONCE_EXCHANGE_ENDPOINT}`;

/**
 * Read the one-time OAuth code from `?code=` (nonce-exchange flow). Steward
 * redirects to the callback with `?code=<NONCE>` and **no tokens** in the
 * URL. We pull the code, strip it from history immediately so it doesn't
 * appear in browser history / extension snapshots / shared URLs, and POST it
 * server-side. Returns null when no code is present so the caller can fall
 * through to the hash / query token fallbacks during the rollout window.
 */
function consumeStewardCodeFromQuery(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return null;
  params.delete("code");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    query
      ? `${window.location.pathname}?${query}`
      : window.location.pathname,
  );
  return code;
}

/**
 * Parse Steward tokens from the URL hash fragment. The hash never leaves the
 * browser — it is not sent to the server, not written to access logs, not
 * passed via Referer, and not stored in browser history beyond what the SPA
 * sees on first paint. Strips the hash from `location` immediately after
 * reading so it cannot be re-read or copy-pasted out of the address bar.
 *
 * Returns null when no `#token=` is present so the caller can fall through to
 * the legacy `?token=` query parser during the rollout window.
 */
function consumeStewardTokensFromHash(): {
  token: string;
  refreshToken: string | null;
} | null {
  // The inline pre-init script in index.html snapshots and removes any
  // `#token=...` fragment before React mounts and stores it on
  // window.__stewardOAuthHash. Prefer that so we never depend on the
  // fragment still being in `location.hash` by the time React boots
  // (analytics, Sentry, etc. may have already read `location.href`).
  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const snapshotted = stewardWindow.__stewardOAuthHash;
  const hash = snapshotted || window.location.hash;
  if (snapshotted) {
    delete stewardWindow.__stewardOAuthHash;
  }
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (!token) return null;
  const refreshToken = params.get("refreshToken");
  if (!snapshotted) {
    // Fallback path (legacy browsers without the inline script): strip the
    // hash now. `replaceState` keeps pathname + search intact.
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return { token, refreshToken };
}

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
        basePath={BRAND_PATHS.clouds}
        speed="4x"
        poster={BRAND_PATHS.poster}
        posterSrcSet={`${BRAND_PATHS.poster480} 640w, ${BRAND_PATHS.poster} 960w`}
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

function ProductDetail({ product }: { product: Product }) {
  return (
    <div className="os-shell">
      <Header solid />
      <main id="main">
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
            <ProductImage product={product} priority />
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
      <main id="main">
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
    // Preferred path: server-side nonce exchange. Steward redirects to
    // `?code=<nonce>` (no tokens in the URL at all). We POST the code to the
    // cloud-api server-side exchange route, which calls Steward
    // `/auth/oauth/exchange` and sets HttpOnly cookies. Access and refresh
    // tokens never enter this process.
    const code = consumeStewardCodeFromQuery();
    if (code) {
      setStatus("syncing");
      exchangeStewardCode(code, {
        endpoint: stewardNonceExchangeEndpoint,
        redirectUri: buildOAuthRedirectUri(product),
        tenantId: stewardTenantId,
      })
        .then(() => {
          setIsAuthed(true);
        })
        .catch((error: unknown) => {
          setMessage(
            error instanceof Error
              ? error.message
              : "Could not complete Eliza Cloud sign-in.",
          );
        })
        .finally(() => setStatus("idle"));
      return;
    }

    // Fallback (one-release rollout window): tokens in the URL hash
    // (#token=...). Hash never leaves the browser, but the tokens still
    // touch JS — preferred only until all consumers have moved to the
    // nonce-exchange flow above. Legacy `?token=` query also accepted.
    const fromHash = consumeStewardTokensFromHash();
    const params = new URLSearchParams(window.location.search);
    const queryToken = params.get("token");
    const queryRefreshToken = params.get("refreshToken");
    const token = fromHash?.token ?? queryToken;
    const refreshToken =
      fromHash?.refreshToken ?? queryRefreshToken ?? undefined;
    if (!token) {
      setIsAuthed(Boolean(getStoredStewardToken()) || hasStewardAuthedCookie());
      return;
    }

    setStatus("syncing");
    writeStoredStewardToken(token);
    if (refreshToken) {
      writeStoredStewardRefreshToken(refreshToken);
    }

    syncStewardSession(token, refreshToken ?? null, {
      endpoint: stewardSessionEndpoint,
    })
      .then(() => {
        setIsAuthed(true);
        if (queryToken || queryRefreshToken) {
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
        }
      })
      .catch((error: unknown) => {
        setMessage(
          error instanceof Error
            ? error.message
            : "Could not sync Eliza Cloud session.",
        );
      })
      .finally(() => setStatus("idle"));
  }, [product]);

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
      await startStripeCheckout(
        {
          hardwareColor: selectedColor.name,
          hardwareSku: product.sku,
          returnUrl: "billing",
        },
        {
          apiBaseUrl: cloudApiUrl,
          bearerToken: getStoredStewardToken(),
        },
      );
    } catch (error) {
      setStatus("idle");
      if (error instanceof StripeCheckoutError && error.status === 401) {
        setIsAuthed(false);
      }
      setMessage(
        error instanceof Error ? error.message : "Could not start checkout.",
      );
    }
  }

  return (
    <div className="os-shell">
      <Header solid />
      <main id="main">
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
              <ProductImage product={product} priority />
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
                    key={color.id}
                    className={
                      selectedColor.id === color.id
                        ? "color-swatch color-swatch-active"
                        : "color-swatch"
                    }
                    style={{
                      backgroundColor:
                        color.name === "Orange"
                          ? BRAND_COLORS.orange
                          : color.name.startsWith("Blue")
                            ? BRAND_COLORS.blue
                            : color.name === "Black"
                              ? BRAND_COLORS.black
                              : BRAND_COLORS.white,
                    }}
                    onClick={() => setSelectedColor(color)}
                    aria-label={`Select ${color.name}`}
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
                href={`${checkoutBaseUrl}?collection=elizaos-hardware`}
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
