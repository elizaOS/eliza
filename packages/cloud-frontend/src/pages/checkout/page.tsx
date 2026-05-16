import {
  ArrowRight,
  Box,
  Check,
  CreditCard,
  Loader2,
  PackageCheck,
  Palette,
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
  | "elizaos-usb-plastic";

type HardwareProduct = {
  sku: HardwareSku;
  name: string;
  price: string;
  subtitle: string;
  colors: Array<{ id: string; name: string }>;
  image?: string;
  kind: "phone" | "box" | "usb" | "chibi";
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
    image: "/product/elizaos-box-concept.avif",
    kind: "box",
  },
  {
    sku: "elizaos-usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    subtitle: "Character USB installer. Ships October 2026.",
    colors: [{ id: "chibi-orange", name: "Orange" }],
    image: "/product/elizaos-usb-key-concept.png",
    kind: "chibi",
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
    kind: "usb",
  },
];

const colorMap: Record<string, string> = {
  Orange: "#ff5800",
  Blue: "#0057ff",
  White: "#f7f6f1",
  Black: "#111111",
};

function getProduct(sku: string | null): HardwareProduct {
  return (
    products.find((product) => product.sku === sku) ??
    products.find((product) => product.sku === "elizaos-usb-plastic") ??
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
  if (product.kind === "box") return <Box aria-hidden="true" />;
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
    <div className="theme-cloud min-h-screen bg-black font-poppins text-white">
      <Helmet>
        <title>ElizaOS Hardware Checkout | Eliza Cloud</title>
        <meta
          name="description"
          content="Buy ElizaOS phone, Box, and USB installer hardware with your Eliza Cloud account."
        />
      </Helmet>
      <LandingHeader />
      <main className="relative z-10 mx-auto grid min-h-screen w-full max-w-6xl gap-6 px-5 pb-16 pt-28 text-white md:grid-cols-[0.95fr_1.05fr] md:px-8">
        <section className="self-start">
          <p className="text-xs font-bold uppercase text-[#FF5800]">
            ElizaOS hardware
          </p>
          <h1 className="mt-3 max-w-xl text-4xl font-semibold leading-[0.98] tracking-normal text-white md:text-6xl">
            Buy with your Eliza Cloud account.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-white/70 md:text-lg">
            Checkout, order status, device linking, and installer downloads all
            stay in one account.
          </p>
          <div className="mt-8 grid gap-3">
            {[
              "Phone, Box, and USB installer SKUs",
              "Orange, blue, white, and black colorways",
              "USB keys ship October 2026",
              "Beta self-install remains available today",
            ].map((item) => (
              <div
                className="flex items-center gap-2 border border-white/14 bg-black px-4 py-3 text-sm font-medium text-white"
                key={item}
              >
                <Check aria-hidden="true" className="size-4 text-[#FF5800]" />
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="border border-white/14 bg-black p-4 text-white md:p-5">
          <div className="grid gap-4 md:grid-cols-[0.9fr_1fr]">
            <HardwareVisual product={product} />
            <div className="flex flex-col justify-between gap-5">
              <div>
                <div className="flex items-center gap-3">
                  <ProductIcon product={product} />
                  <div>
                    <h2 className="text-2xl font-semibold">{product.name}</h2>
                    <p className="text-sm text-[#6a6660]">{product.subtitle}</p>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  {product.colors.map((color) => (
                    <button
                      aria-label={`Select ${color.name}`}
                      className={`size-7 rounded-full border shadow-[inset_0_0_0_2px_rgba(255,255,255,0.55)] ${
                        selectedColor.id === color.id
                          ? "border-[#111] ring-2 ring-[#FF5800]"
                          : "border-black/20"
                      }`}
                      key={color.id}
                      onClick={() => setSelectedColor(color)}
                      style={{ backgroundColor: colorMap[color.name] }}
                      title={color.name}
                      type="button"
                    />
                  ))}
                </div>
                <div className="mt-6 grid gap-2 rounded-lg bg-[#f7f5ef] p-4 text-sm text-[#5f5a53]">
                  <span className="flex items-center gap-2">
                    <Palette className="size-4 text-[#FF5800]" />
                    {selectedColor.name} is captured with the order.
                  </span>
                  <span className="flex items-center gap-2">
                    <PackageCheck className="size-4 text-[#FF5800]" />
                    Device linking happens after checkout.
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-black/10 pt-4">
                <strong className="text-xl">{product.price}</strong>
                {session.authenticated ? (
                  <button
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#111] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
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
                    Continue to payment
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </button>
                ) : (
                  <Link
                    to={loginTarget}
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#111] px-4 text-sm font-semibold text-white"
                  >
                    <CreditCard aria-hidden="true" className="size-4" />
                    Sign in to buy
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                )}
              </div>
              {checkoutError ? (
                <p className="text-sm font-medium text-red-600">
                  {checkoutError}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {collection === "elizaos-hardware" ? (
          <section className="rounded-lg border border-black/10 bg-white/80 p-4 md:col-span-2">
            <h2 className="text-xl font-semibold">ElizaOS hardware catalog</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {products.map((item) => (
                <Link
                  className={`rounded-lg border p-3 ${
                    item.sku === product.sku
                      ? "border-[#FF5800] bg-[#fff5ee]"
                      : "border-black/10 bg-white"
                  }`}
                  key={item.sku}
                  to={`/checkout?collection=elizaos-hardware&sku=${item.sku}`}
                >
                  <span className="text-sm font-semibold">{item.name}</span>
                  <span className="mt-1 block text-xs text-[#6a6660]">
                    {item.price}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
