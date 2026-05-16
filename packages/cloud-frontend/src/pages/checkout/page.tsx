import { CloudVideoBackground } from "@elizaos/ui";
import {
  BRAND_COLORS,
  BRAND_PATHS,
  CONCEPT_PRODUCT_IMAGES,
  LOGO_FILES,
} from "@elizaos/shared-brand";
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

type HardwareSku =
  | "elizaos-phone"
  | "elizaos-box"
  | "elizaos-usb-chibi"
  | "elizaos-usb"
  | "elizaos-raspberry-pi-case"
  | "elizaos-custom-raspberry-pi-case"
  | "elizaos-mini-pc"
  | "elizaos-usb-plastic";

type HardwareProduct = {
  sku: HardwareSku;
  name: string;
  price: string;
  subtitle: string;
  colors: Array<{ id: string; name: string }>;
  image?: string;
  kind: "phone" | "box" | "usb" | "chibi" | "mini";
};

const products: HardwareProduct[] = [
  {
    sku: "elizaos-phone",
    name: "ElizaOS Phone",
    price: "$499 deposit",
    subtitle: "Reserve first-party phone hardware.",
    colors: [
      { id: "phone-orange", name: "Orange" },
      { id: "phone-blue-frame", name: "Blue" },
      { id: "phone-white", name: "White" },
      { id: "phone-blue-glass", name: "Blue" },
    ],
    image: CONCEPT_PRODUCT_IMAGES.phone,
    kind: "phone",
  },
  {
    sku: "elizaos-box",
    name: "ElizaOS Box",
    price: "$299 deposit",
    subtitle: "Reserve the ElizaOS home/runtime box.",
    colors: [
      { id: "box-orange", name: "Orange" },
      { id: "box-blue", name: "Blue" },
      { id: "box-white", name: "White" },
      { id: "box-black", name: "Black" },
    ],
    image: CONCEPT_PRODUCT_IMAGES.billboard,
    kind: "box",
  },
  {
    sku: "elizaos-usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    subtitle: "Character USB installer. Ships October 2026.",
    colors: [{ id: "chibi-orange", name: "Orange" }],
    image: CONCEPT_PRODUCT_IMAGES.chibiUsb,
    kind: "chibi",
  },
  {
    sku: "elizaos-usb",
    name: "ElizaOS USB key",
    price: "$49",
    subtitle: "Simple branded USB installer. Ships October 2026.",
    colors: [
      { id: "usb-orange", name: "Orange" },
      { id: "usb-blue", name: "Blue" },
      { id: "usb-white", name: "White" },
      { id: "usb-black", name: "Black" },
    ],
    image: CONCEPT_PRODUCT_IMAGES.usbDrive,
    kind: "usb",
  },
  {
    sku: "elizaos-usb-plastic",
    name: "Branded USB key",
    price: "$49",
    subtitle: "Simple plastic USB installer. Ships October 2026.",
    colors: [
      { id: "usb-orange", name: "Orange" },
      { id: "usb-blue", name: "Blue" },
      { id: "usb-white", name: "White" },
      { id: "usb-black", name: "Black" },
    ],
    image: CONCEPT_PRODUCT_IMAGES.usbDrive,
    kind: "usb",
  },
  {
    sku: "elizaos-raspberry-pi-case",
    name: "Raspberry Pi case",
    price: "$49",
    subtitle: "ElizaOS case for a local agent board.",
    colors: [
      { id: "case-orange", name: "Orange" },
      { id: "case-blue", name: "Blue" },
      { id: "case-white", name: "White" },
      { id: "case-black", name: "Black" },
    ],
    image: "/product/elizaos-box-concept.avif",
    kind: "box",
  },
  {
    sku: "elizaos-custom-raspberry-pi-case",
    name: "Raspberry Pi + case",
    price: "$149",
    subtitle: "Custom Pi kit in the ElizaOS case.",
    colors: [
      { id: "kit-orange", name: "Orange" },
      { id: "kit-blue", name: "Blue" },
      { id: "kit-white", name: "White" },
      { id: "kit-black", name: "Black" },
    ],
    image: "/product/elizaos-box-concept.avif",
    kind: "box",
  },
  {
    sku: "elizaos-mini-pc",
    name: "ElizaOS mini PC",
    price: "$1999",
    subtitle: "Always-on local compute for agents.",
    colors: [
      { id: "mini-orange", name: "Orange" },
      { id: "mini-blue", name: "Blue" },
      { id: "mini-white", name: "White" },
      { id: "mini-black", name: "Black" },
    ],
    image: CONCEPT_PRODUCT_IMAGES.miniPc,
    kind: "mini",
  },
];

const colorMap: Record<string, string> = {
  Orange: BRAND_COLORS.orange,
  Blue: BRAND_COLORS.blue,
  White: BRAND_COLORS.white,
  Black: BRAND_COLORS.black,
};

function getProduct(sku: string | null): HardwareProduct {
  return (
    products.find((product) => product.sku === sku) ??
    products.find((product) => product.sku === "elizaos-usb") ??
    products[0]
  );
}

function HardwareVisual({ product }: { product: HardwareProduct }) {
  if (product.image) {
    return (
      <div className={`checkout-visual ${product.kind}`}>
        <img alt="" src={product.image} />
      </div>
    );
  }

  return (
    <div className={`checkout-visual ${product.kind}`}>
      <img alt="" src="/product/elizaos-face.svg" />
      <span>{product.kind === "usb" ? "USB" : "elizaOS"}</span>
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
      const response = await fetch("/api/stripe/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hardwareColor: selectedColor.name,
          hardwareSku: product.sku,
          returnUrl: "billing",
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.url) {
        throw new Error(data.error || "Could not start hardware checkout.");
      }

      window.location.href = data.url;
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
      <main id="main" className="relative z-10 mx-auto grid min-h-screen w-full max-w-7xl gap-10 px-5 pb-16 pt-28 text-white md:grid-cols-[0.85fr_1.15fr] md:px-8 lg:px-12">
        <section className="self-center">
          <img
            src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
            alt="Eliza Cloud"
            className="mb-8 h-9 w-auto"
            draggable={false}
          />
          <p className="text-xs font-bold uppercase text-[#FF5800]">preorder</p>
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
                      className={`size-8 ${
                        selectedColor.id === color.id
                          ? "ring-2 ring-[#FF5800]"
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
                <p className="text-sm font-medium text-[#FF5800]">
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
                      ? "bg-[#FF5800] text-black"
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
