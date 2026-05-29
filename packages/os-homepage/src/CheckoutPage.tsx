import { BRAND_COLORS, BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  StripeCheckoutError,
  startStripeCheckout,
} from "@elizaos/shared/checkout";
import {
  HARDWARE_PRODUCTS as hardwareProducts,
  type Product,
} from "@elizaos/shared/hardware-catalog";
import {
  exchangeStewardCode,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  STEWARD_NONCE_EXCHANGE_ENDPOINT,
  STEWARD_SESSION_ENDPOINT,
  STEWARD_TENANT_ID,
  syncStewardSession,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { StewardAuth } from "@stwd/sdk";
import { CreditCard } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useT } from "./providers/I18nProvider";

const cloudApiUrl =
  import.meta.env.VITE_ELIZA_CLOUD_API_URL || "https://api.elizacloud.ai";
const stewardApiUrl = `${cloudApiUrl.replace(/\/$/, "")}/steward`;
const stewardTenantId = STEWARD_TENANT_ID;
const stewardSessionEndpoint = `${cloudApiUrl.replace(/\/$/, "")}${STEWARD_SESSION_ENDPOINT}`;
const stewardNonceExchangeEndpoint = `${cloudApiUrl.replace(/\/$/, "")}${STEWARD_NONCE_EXCHANGE_ENDPOINT}`;

type StewardTokenPayload = {
  token: string;
  refreshToken: string | null;
};

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

function buildOAuthRedirectUri(product: Product): string {
  return `${window.location.origin}${buildCheckoutPath(product)}`;
}

function buildOAuthUrl(provider: "google" | "discord" | "github") {
  const product = getCheckoutProduct();
  const params = new URLSearchParams({
    redirect_uri: buildOAuthRedirectUri(product),
    tenant_id: stewardTenantId,
    response_type: "code",
  });
  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}

function getStoredStewardToken() {
  return readStoredStewardToken();
}

function readStewardTokenParams(
  params: URLSearchParams,
): StewardTokenPayload | null {
  const token = params.get("token") ?? params.get("access_token");
  if (!token) return null;
  return {
    token,
    refreshToken: params.get("refreshToken") ?? params.get("refresh_token"),
  };
}

function hasStewardTokenParams(params: URLSearchParams): boolean {
  return (
    params.has("token") ||
    params.has("access_token") ||
    params.has("refreshToken") ||
    params.has("refresh_token")
  );
}

function removeStewardTokenParams(params: URLSearchParams): void {
  params.delete("token");
  params.delete("access_token");
  params.delete("refreshToken");
  params.delete("refresh_token");
}

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
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
  return code;
}

function consumeStewardTokensFromHash(): {
  token: string;
  refreshToken: string | null;
} | null {
  const stewardWindow = window as Window & { __stewardOAuthHash?: string };
  const snapshotted = stewardWindow.__stewardOAuthHash;
  const hash = snapshotted || window.location.hash;
  if (snapshotted) {
    delete stewardWindow.__stewardOAuthHash;
  }
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const tokens = readStewardTokenParams(params);
  if (!tokens && !hasStewardTokenParams(params)) return null;
  if (!snapshotted || !tokens) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return tokens;
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

function Header() {
  const t = useT();
  return (
    <header className="site-header site-header-solid">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[200] focus:bg-black focus:px-3 focus:py-2 focus:text-sm focus:text-white focus:outline focus:outline-2 focus:outline-[color:var(--brand-orange)]"
      >
        {t("homepage_os.common.skipToContent", { defaultValue: "Skip to content" })}
      </a>
      <a
        href="/"
        className="brand"
        aria-label={t("homepage_os.common.brandHomeAria", {
          defaultValue: "elizaOS home",
        })}
      >
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
          alt={t("homepage_os.common.brandAlt", { defaultValue: "elizaOS" })}
          draggable={false}
        />
      </a>
      <nav
        className="site-nav"
        aria-label={t("homepage_os.common.productSwitcherAria", {
          defaultValue: "Product switcher",
        })}
      >
        <a href="/#download">
          {t("homepage_os.common.navDownload", { defaultValue: "Download" })}
        </a>
        <a href="/#hardware">
          {t("homepage_os.common.navHardware", { defaultValue: "Hardware" })}
        </a>
      </nav>
    </header>
  );
}

function Footer() {
  const t = useT();
  return (
    <footer className="site-footer">
      <img
        src={`${BRAND_PATHS.logos}/${LOGO_FILES.osWhite}`}
        alt={t("homepage_os.common.brandAlt", { defaultValue: "elizaOS" })}
        draggable={false}
      />
      <nav
        aria-label={t("homepage_os.common.communityNavAria", {
          defaultValue: "Community",
        })}
      >
        <a href="https://app.elizaos.ai">
          {t("homepage_os.common.navApp", { defaultValue: "App" })}
        </a>
        <a href="https://elizacloud.ai/login?intent=launch">
          {t("homepage_os.common.navCloud", { defaultValue: "Cloud" })}
        </a>
      </nav>
    </footer>
  );
}

export function CheckoutResult({
  success,
  canceled,
}: {
  success?: boolean;
  canceled?: boolean;
}) {
  const t = useT();
  return (
    <div className="os-shell">
      <Header />
      <main id="main">
        <section className="band band-blue checkout-result">
          <div className="band-inner">
            <h1>
              {success
                ? t("homepage_os.checkoutResult.successTitle", {
                    defaultValue: "Pre-order received.",
                  })
                : t("homepage_os.checkoutResult.canceledTitle", {
                    defaultValue: "Checkout canceled.",
                  })}
            </h1>
            <p>
              {success
                ? t("homepage_os.checkoutResult.successBody", {
                    defaultValue:
                      "Your ElizaOS hardware order is connected to your Eliza Cloud account.",
                  })
                : t("homepage_os.checkoutResult.canceledBody", {
                    defaultValue:
                      "No payment was completed. You can return to the store when ready.",
                  })}
            </p>
            <a href="/#hardware" className="button">
              {canceled
                ? t("homepage_os.checkoutResult.returnToHardware", {
                    defaultValue: "Return to hardware",
                  })
                : t("homepage_os.checkoutResult.backToElizaOs", {
                    defaultValue: "Back to elizaOS",
                  })}
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

export function CheckoutPage() {
  const t = useT();
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
    const code = consumeStewardCodeFromQuery();
    if (code) {
      setStatus("syncing");
      exchangeStewardCode(code, {
        endpoint: stewardNonceExchangeEndpoint,
        redirectUri: buildOAuthRedirectUri(product),
        tenantId: stewardTenantId,
      })
        .then((session) => {
          if (session.token) {
            writeStoredStewardToken(session.token);
          }
          setIsAuthed(Boolean(session.token) || hasStewardAuthedCookie());
        })
        .catch((error: unknown) => {
          setMessage(
            error instanceof Error
              ? error.message
              : t("homepage_os.checkout.errorSignIn", {
                  defaultValue: "Could not complete Eliza Cloud sign-in.",
                }),
          );
        })
        .finally(() => setStatus("idle"));
      return;
    }

    const fromHash = consumeStewardTokensFromHash();
    const params = new URLSearchParams(window.location.search);
    const fromQuery = readStewardTokenParams(params);
    const hadQueryTokenParams = hasStewardTokenParams(params);
    const token = fromHash?.token ?? fromQuery?.token;
    const refreshToken = fromHash?.refreshToken ?? fromQuery?.refreshToken;
    if (!token) {
      if (hadQueryTokenParams) {
        removeStewardTokenParams(params);
        const query = params.toString();
        window.history.replaceState(
          null,
          "",
          query
            ? `${window.location.pathname}?${query}`
            : window.location.pathname,
        );
      }
      setIsAuthed(Boolean(getStoredStewardToken()) || hasStewardAuthedCookie());
      return;
    }

    setStatus("syncing");
    writeStoredStewardToken(token);

    syncStewardSession(token, refreshToken ?? null, {
      endpoint: stewardSessionEndpoint,
    })
      .then(() => {
        setIsAuthed(true);
        if (hadQueryTokenParams) {
          removeStewardTokenParams(params);
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
            : t("homepage_os.checkout.errorSyncSession", {
                defaultValue: "Could not sync Eliza Cloud session.",
              }),
        );
      })
      .finally(() => setStatus("idle"));
  }, [product, t]);

  useEffect(() => {
    setSelectedColor(product.colors[0]);
  }, [product]);

  async function sendMagicLink() {
    if (!email.trim()) {
      setMessage(
        t("homepage_os.checkout.enterEmailFirst", {
          defaultValue: "Enter your email first.",
        }),
      );
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
        error instanceof Error
          ? error.message
          : t("homepage_os.checkout.errorMagicLink", {
              defaultValue: "Could not send magic link.",
            }),
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
        error instanceof Error
          ? error.message
          : t("homepage_os.checkout.errorStartCheckout", {
              defaultValue: "Could not start checkout.",
            }),
      );
    }
  }

  return (
    <div className="os-shell">
      <Header />
      <main id="main">
        <section className="band band-blue checkout-hero">
          <div className="band-inner checkout-grid">
            <div className="checkout-copy">
              <p className="section-kicker">
                {t("homepage_os.checkout.preOrderKicker", {
                  defaultValue: "Pre-order",
                })}
              </p>
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
              <h2>
                {t("homepage_os.checkout.title", {
                  defaultValue: "Checkout on elizaOS.",
                })}
              </h2>
              <p className="section-lede">
                {t("homepage_os.checkout.lede", {
                  defaultValue:
                    "Login, customer records, credits, and Stripe payments are provided by Eliza Cloud.",
                })}
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
                    <strong>
                      {item.price ??
                        t("homepage_os.checkout.preOrder", {
                          defaultValue: "Pre-order",
                        })}
                    </strong>
                  </button>
                ))}
              </div>

              <fieldset
                className="color-row"
                aria-label={t("homepage_os.checkout.colorRowAria", {
                  defaultValue: "Hardware color",
                })}
              >
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
                    aria-label={t("homepage_os.checkout.selectColorAria", {
                      defaultValue: "Select {{color}}",
                      color: color.name,
                    })}
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
                  {status === "checkout"
                    ? t("homepage_os.checkout.openingStripe", {
                        defaultValue: "Opening Stripe...",
                      })
                    : t("homepage_os.checkout.payDeposit", {
                        defaultValue: "Pay deposit",
                      })}
                </button>
              ) : (
                <div className="login-box">
                  <div className="email-row">
                    <input
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder={t("homepage_os.checkout.emailPlaceholder", {
                        defaultValue: "you@example.com",
                      })}
                      type="email"
                    />
                    <button
                      type="button"
                      onClick={sendMagicLink}
                      disabled={status === "syncing"}
                    >
                      {t("homepage_os.checkout.emailLink", {
                        defaultValue: "Email link",
                      })}
                    </button>
                  </div>
                  <div className="oauth-row">
                    <a href={buildOAuthUrl("google")}>
                      {t("homepage_os.checkout.oauthGoogle", {
                        defaultValue: "Google",
                      })}
                    </a>
                    <a href={buildOAuthUrl("github")}>
                      {t("homepage_os.checkout.oauthGitHub", {
                        defaultValue: "GitHub",
                      })}
                    </a>
                    <a href={buildOAuthUrl("discord")}>
                      {t("homepage_os.checkout.oauthDiscord", {
                        defaultValue: "Discord",
                      })}
                    </a>
                  </div>
                </div>
              )}
              {status === "email-sent" ? (
                <p className="checkout-message">
                  {t("homepage_os.checkout.checkInbox", {
                    defaultValue: "Check your inbox.",
                  })}
                </p>
              ) : null}
              {message ? (
                <p className="checkout-message" role="alert">
                  {message}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

export default CheckoutPage;
