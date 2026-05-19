/**
 * Canonical hardware product catalog.
 *
 * Single source of truth for hardware SKUs, copy, pricing, and color options
 * shared across:
 *   - `@elizaos/os-homepage` (marketing site product tiles + checkout)
 *   - `@elizaos/cloud-frontend` (signed-in checkout page)
 *   - `@elizaos/cloud-api` (Stripe checkout-session creation)
 *
 * Adding a product here automatically:
 *   - Adds a tile to both checkout flows
 *   - Adds the SKU to the cloud-api Zod enum and Stripe line-item builder
 *
 * Do NOT add Stripe price IDs here unless we move to a managed-price model;
 * cloud-api currently builds `price_data` inline from `priceUsd`.
 */

import { CONCEPT_PRODUCT_IMAGES } from "../brand/index.js";

export type ProductKind = "phone" | "box" | "usb" | "chibi" | "mini";

export type ProductColor = {
  /** Stable per-product color id, e.g. "usb-orange". */
  id: string;
  /** Human-readable color name, e.g. "Orange". Used as the Stripe metadata value. */
  name: string;
};

export type Product = {
  /** URL slug for product landing pages (`/hardware/<slug>`). */
  slug: string;
  /** Stable SKU. Sent to Stripe metadata and used everywhere as the lookup key. */
  sku: string;
  /** Display name. */
  name: string;
  /** Display price (e.g. "$49" or "$499 deposit"). */
  price: string;
  /** Stripe unit amount in USD (integer dollars). */
  priceUsd: number;
  /** Optional shipping copy (e.g. "Ships October 2026" or "Pre-order"). */
  ships?: string;
  /** Path under `/brand/concepts/` (already synced into each app's `public/`). */
  image: string;
  /** Alt text for the product image. */
  imageAlt: string;
  /** Short marketing summary (one sentence). */
  summary: string;
  /** Longer marketing detail (one sentence). */
  detail: string;
  /** Short subtitle used by cloud-frontend's checkout panel. */
  subtitle: string;
  /** UI hint used by cloud-frontend to pick an icon and visual layout. */
  kind: ProductKind;
  /** Selectable colors. */
  colors: ProductColor[];
  /** Stripe line-item product name. */
  stripeName: string;
  /** Stripe line-item product description. */
  stripeDescription: string;
};

const COLOR_SET_FULL = (prefix: string): ProductColor[] => [
  { id: `${prefix}-orange`, name: "Orange" },
  { id: `${prefix}-blue`, name: "Blue" },
  { id: `${prefix}-white`, name: "White" },
  { id: `${prefix}-black`, name: "Black" },
];

export const HARDWARE_PRODUCTS = [
  {
    slug: "usb",
    sku: "elizaos-usb",
    name: "ElizaOS USB",
    price: "$49",
    priceUsd: 49,
    ships: "Ships October 2026",
    image: CONCEPT_PRODUCT_IMAGES.usbDrive,
    imageAlt: "Blue ElizaOS USB drive concept",
    summary: "Boot elizaOS from your pocket.",
    detail: "Live image on a stick. Plug into any UEFI PC and run.",
    subtitle: "Simple branded USB installer. Ships October 2026.",
    kind: "usb",
    colors: COLOR_SET_FULL("usb"),
    stripeName: "ElizaOS USB key preorder",
    stripeDescription:
      "First-party ElizaOS USB installer key. Ships October 2026.",
  },
  {
    slug: "usb-plastic",
    sku: "elizaos-usb-plastic",
    name: "Branded USB key",
    price: "$49",
    priceUsd: 49,
    ships: "Ships October 2026",
    image: CONCEPT_PRODUCT_IMAGES.usbDrive,
    imageAlt: "Branded ElizaOS plastic USB key concept",
    summary: "Plastic USB installer in ElizaOS branding.",
    detail: "Simple plastic USB key with the ElizaOS live installer.",
    subtitle: "Simple plastic USB installer. Ships October 2026.",
    kind: "usb",
    colors: COLOR_SET_FULL("usb-plastic"),
    stripeName: "Branded USB key preorder",
    stripeDescription:
      "Simple plastic ElizaOS USB installer key. Ships October 2026.",
  },
  {
    slug: "chibi-usb",
    sku: "elizaos-usb-chibi",
    name: "Chibi USB key",
    price: "$49",
    priceUsd: 49,
    ships: "Ships October 2026",
    image: CONCEPT_PRODUCT_IMAGES.chibiUsb,
    imageAlt: "Chibi ElizaOS USB key concept",
    summary: "Same boot key. Smaller mascot shell.",
    detail: "ElizaOS USB in a collector enclosure.",
    subtitle: "Character USB installer. Ships October 2026.",
    kind: "chibi",
    colors: [{ id: "chibi-orange", name: "Orange" }],
    stripeName: "Chibi USB key preorder",
    stripeDescription:
      "Character ElizaOS USB installer key. Ships October 2026.",
  },
  {
    slug: "case",
    sku: "elizaos-raspberry-pi-case",
    name: "Raspberry Pi case",
    price: "$49",
    priceUsd: 49,
    ships: "Ships October 2026",
    image: CONCEPT_PRODUCT_IMAGES.billboard,
    imageAlt: "ElizaOS Raspberry Pi case concept",
    summary: "A shell for a local agent.",
    detail: "Bring your own Pi. We ship the enclosure.",
    subtitle: "ElizaOS case for a local agent board.",
    kind: "box",
    colors: COLOR_SET_FULL("case"),
    stripeName: "ElizaOS Raspberry Pi case preorder",
    stripeDescription: "Reserve the ElizaOS Raspberry Pi case.",
  },
  {
    slug: "raspberry-pi",
    sku: "elizaos-custom-raspberry-pi-case",
    name: "Custom Raspberry Pi + case",
    price: "$149",
    priceUsd: 149,
    ships: "Ships October 2026",
    image: CONCEPT_PRODUCT_IMAGES.billboard,
    imageAlt: "ElizaOS Raspberry Pi kit concept",
    summary: "Plug in, boot, run local.",
    detail: "Pi, case, SD card pre-imaged. One box, one cable.",
    subtitle: "Custom Pi kit in the ElizaOS case.",
    kind: "box",
    colors: COLOR_SET_FULL("kit"),
    stripeName: "ElizaOS Raspberry Pi + case preorder",
    stripeDescription: "Reserve the custom Raspberry Pi and ElizaOS case kit.",
  },
  {
    slug: "mini-pc",
    sku: "elizaos-mini-pc",
    name: "ElizaOS mini PC",
    price: "$1999",
    priceUsd: 1999,
    ships: "Ships October 2026",
    image: CONCEPT_PRODUCT_IMAGES.miniPc,
    imageAlt: "ElizaOS mini PC concept",
    summary: "Always-on compute for agents.",
    detail: "Desktop-class inference at home. Quiet, owned, yours.",
    subtitle: "Always-on local compute for agents.",
    kind: "mini",
    colors: COLOR_SET_FULL("mini"),
    stripeName: "ElizaOS mini PC preorder",
    stripeDescription: "Reserve the first-party ElizaOS mini PC.",
  },
  {
    slug: "phone",
    sku: "elizaos-phone",
    name: "ElizaOS Phone",
    price: "$499 deposit",
    priceUsd: 499,
    ships: "Pre-order",
    image: CONCEPT_PRODUCT_IMAGES.phone,
    imageAlt: "Eliza Phone concept",
    summary: "The runtime in your hand.",
    detail: "AOSP build with elizaOS as the shell.",
    subtitle: "Reserve first-party phone hardware.",
    kind: "phone",
    colors: [
      { id: "phone-orange", name: "Orange" },
      { id: "phone-blue-frame", name: "Blue" },
      { id: "phone-white", name: "White" },
      { id: "phone-blue-glass", name: "Blue glass" },
    ],
    stripeName: "ElizaOS Phone preorder deposit",
    stripeDescription: "Reserve first-party ElizaOS phone hardware.",
  },
  {
    slug: "box",
    sku: "elizaos-box",
    name: "ElizaOS Box",
    price: "$299 deposit",
    priceUsd: 299,
    ships: "Pre-order",
    image: CONCEPT_PRODUCT_IMAGES.billboard,
    imageAlt: "ElizaOS box hardware concept",
    summary: "A household agent appliance.",
    detail: "Sits on the shelf. Runs the home.",
    subtitle: "Reserve the ElizaOS home/runtime box.",
    kind: "box",
    colors: COLOR_SET_FULL("box"),
    stripeName: "ElizaOS Box preorder deposit",
    stripeDescription: "Reserve the ElizaOS home/runtime box.",
  },
] as const satisfies readonly Product[];

export type HardwareSku = (typeof HARDWARE_PRODUCTS)[number]["sku"];

export const HARDWARE_SKUS = HARDWARE_PRODUCTS.map((p) => p.sku) as [
  HardwareSku,
  ...HardwareSku[],
];

export function findBySku(sku: string): Product | undefined {
  return HARDWARE_PRODUCTS.find((product) => product.sku === sku);
}

export function findBySlug(slug: string): Product | undefined {
  return HARDWARE_PRODUCTS.find((product) => product.slug === slug);
}
