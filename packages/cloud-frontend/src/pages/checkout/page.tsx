import { startStripeCheckout } from "@elizaos/checkout-shared";
import {
  HARDWARE_PRODUCTS,
  type Product as HardwareProduct,
} from "@elizaos/hardware-catalog";
import { BRAND_COLORS, BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import { CloudVideoBackground } from "@elizaos/ui";
import {
  ArrowRight,
  Box,
  CreditCard,
  Loader2,
  Smartphone,
  Usb,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useSearchParams } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import LandingHeader from "../../components/layout/landing-header";

const products = HARDWARE_PRODUCTS;

const colorMap: Record<string, string> = {
  Orange: BRAND_COLORS.orange,
  Blue: BRAND_COLORS.blue,
  "Blue glass": BRAND_COLORS.blue,
  White: BRAND_COLORS.white,
  Black: BRAND_COLORS.black,
};

function getProduct(sku: string | null): HardwareProduct {
  const fallback =
    products.find((product) => product.sku === sku) ??
    products.find((product) => product.sku === "elizaos-usb") ??
    products[0];
  if (!fallback) throw new Error("Hardware catalog is empty");
  return fallback;
}

function HardwareVisual({ product }: { product: HardwareProduct }) {
  return (
    <div className={`checkout-visual ${product.kind}`}>
      <img alt={product.imageAlt} src={product.image} />
    </div>
  );
}

function ProductIcon({ product }: { product: HardwareProduct }) {
  if (product.kind === "phone") return <Smartphone aria-hidden="true" />;
  if (product.kind === "box" || product.kind === "mini")
    return <Box aria-hidden="true" />;
  return <Usb aria-hidden="true" />;
}

export default function CheckoutPage() {
  const [searchParams] = useSearchParams();
  const session = useSessionAuth();
  const sku = searchParams.get("sku");
  const collection = searchParams.get("collection");
  const product = getProduct(sku);
  const [selectedColor, setSelectedColor] = useState(product.colors[0]);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const loginTarget = `/login?intent=signup&redirect=${encodeURIComponent(
    `/checkout?sku=${product.sku}`,
  )}`;

  useEffect(() => {
    setSelectedColor(product.colors[0]);
    setCheckoutError(null);
  }, [product]);

  async function beginHardwareCheckout() {
    setCheckoutError(null);
    setIsStartingCheckout(true);

    try {
      await startStripeCheckout(
        {
          hardwareColor: selectedColor.name,
          hardwareSku: product.sku,
          returnUrl: "billing",
        },
        { apiBaseUrl: "", credentials: "same-origin" },
      );
    } catch (error) {
      setCheckoutError(
        error instanceof Error
          ? error.message
          : "Could not start hardware checkout.",
      );
      setIsStartingCheckout(false);
    }
  }

  return (
    <CloudVideoBackground
      basePath={BRAND_PATHS.clouds}
      speed="4x"
      poster={BRAND_PATHS.poster}
      scrim={0.86}
      scrimColor="rgba(0,0,0,1)"
      className="theme-cloud min-h-screen bg-black font-poppins text-white"
    >
      <Helmet>
        <title>Preorder | Eliza Cloud</title>
        <meta
          name="description"
          content="Preorder ElizaOS hardware with your Eliza Cloud account."
        />
      </Helmet>
      <LandingHeader />
      <main
        id="main"
        className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl gap-10 px-5 pb-16 pt-28 text-white md:grid-cols-[0.85fr_1.15fr] md:px-8 lg:px-12"
      >
        <section className="self-center">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
            alt="Eliza Cloud"
            className="mb-8 h-9 w-auto"
            draggable={false}
          />
          <p className="text-xs font-bold uppercase text-[var(--brand-orange)]">preorder</p>
          <h1 className="mt-3 max-w-xl break-words text-4xl font-extrabold leading-[0.9] text-white sm:text-5xl md:text-7xl">
            {product.name}
          </h1>
          <p className="mt-5 max-w-lg text-lg font-medium leading-snug text-white/72">
            Reserve with your Eliza Cloud account.
          </p>
          <div className="mt-8 flex flex-wrap gap-3 text-xs font-semibold uppercase text-white/74">
            <span>{product.price}</span>
            <span>{product.subtitle}</span>
          </div>
        </section>

        <section className="self-center bg-black/78 p-4 text-white md:p-5">
          <div className="grid gap-5 md:grid-cols-[0.95fr_1fr]">
            <div className="bg-white p-0">
              <HardwareVisual product={product} />
            </div>
            <div className="flex flex-col justify-between gap-6">
              <div>
                <div className="flex items-center gap-3">
                  <ProductIcon product={product} />
                  <div>
                    <h2 className="text-2xl font-semibold text-white">
                      {product.name}
                    </h2>
                    <p className="text-sm text-white/74">{product.subtitle}</p>
                  </div>
                </div>
                <div className="mt-6 flex flex-wrap gap-2">
                  {product.colors.map((color) => (
                    <button
                      aria-label={`Select ${color.name}`}
                      className={`size-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black ${
                        selectedColor.id === color.id
                          ? "ring-2 ring-[var(--brand-orange)]"
                          : "ring-1 ring-white/30"
                      }`}
                      key={color.id}
                      onClick={() => setSelectedColor(color)}
                      style={{ backgroundColor: colorMap[color.name] }}
                      title={color.name}
                      type="button"
                    />
                  ))}
                </div>
                <div className="mt-6 bg-white/[0.06] p-4 text-sm text-white/70">
                  {selectedColor.name} selected.
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 pt-5">
                <strong className="text-xl text-white">{product.price}</strong>
                {session.authenticated ? (
                  <button
                    className="inline-flex min-h-11 items-center gap-2 bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isStartingCheckout}
                    onClick={beginHardwareCheckout}
                    type="button"
                  >
                    {isStartingCheckout ? (
                      <Loader2
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                    ) : (
                      <CreditCard aria-hidden="true" className="size-4" />
                    )}
                    Preorder
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </button>
                ) : (
                  <Link
                    to={loginTarget}
                    className="inline-flex min-h-11 items-center gap-2 bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-white/85"
                  >
                    <CreditCard aria-hidden="true" className="size-4" />
                    Sign in to preorder
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                )}
              </div>
              {checkoutError ? (
                <p className="text-sm font-medium text-[var(--brand-orange)]">
                  {checkoutError}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {collection === "elizaos-hardware" ? (
          <section className="bg-black/78 p-4 md:col-span-2">
            <h2 className="text-xl font-semibold text-white">Preorder</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {products.map((item) => (
                <Link
                  className={`p-3 transition-colors ${
                    item.sku === product.sku
                      ? "bg-[var(--brand-orange)] text-black"
                      : "bg-black hover:bg-white/10"
                  }`}
                  key={item.sku}
                  to={`/checkout?collection=elizaos-hardware&sku=${item.sku}`}
                >
                  <span className="text-sm font-semibold">{item.name}</span>
                  <span className="mt-1 block text-xs opacity-70">
                    {item.price}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </CloudVideoBackground>
  );
}
