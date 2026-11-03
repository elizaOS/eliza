import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";

export const MONETIZATION_PUBLIC_KEY_B64 = "XZuPtlchqj37JLDx3ssEjztngYqhPjItESZEURBDY9A=";
export const ADSENSE_CLIENT = "ca-pub-6504655762357230";

function offerRow(row: {
  id: string;
  partner: string;
  title: string;
  blurb: string;
  url?: string;
  image?: string;
  placements?: string[];
  tier: string;
  category: string;
  disclosure: string;
}) {
  return {
    id: String(row.id),
    partner: String(row.partner),
    title: String(row.title),
    blurb: String(row.blurb),
    url: String(row.url || ""),
    image: String(row.image || ""),
    placements: row.placements || [],
    tier: row.tier,
    category: row.category,
    disclosure: row.disclosure,
  };
}

export function canonicalMonetization(doc: {
  adsenseClient?: string;
  admobPublisher?: string;
  admobAppId?: string;
  admobBannerAndroid?: string;
  admobBannerIos?: string;
  admobInterstitialAndroid?: string;
  admobRewardedAndroid?: string;
  admobRewardedIos?: string;
  checkoutUrl?: string;
  checkoutYearlyUrl?: string;
  checkoutLifetimeUrl?: string;
  cryptoReceiveAddress?: string;
  usdcMint?: string;
  priceMonthlyUsd?: number;
  priceYearlyUsd?: number;
  priceLifetimeUsd?: number;
  platformFeeBps?: number;
  proTradeAllowance?: number;
  trialDays?: number;
  offers?: Parameters<typeof offerRow>[0][];
}): string {
  return JSON.stringify({
    adsenseClient: String(doc.adsenseClient || ""),
    admobPublisher: String(doc.admobPublisher || ""),
    admobAppId: String(doc.admobAppId || ""),
    admobBannerAndroid: String(doc.admobBannerAndroid || ""),
    admobBannerIos: String(doc.admobBannerIos || ""),
    admobInterstitialAndroid: String(doc.admobInterstitialAndroid || ""),
    admobRewardedAndroid: String(doc.admobRewardedAndroid || ""),
    admobRewardedIos: String(doc.admobRewardedIos || ""),
    checkoutUrl: String(doc.checkoutUrl || ""),
    checkoutYearlyUrl: String(doc.checkoutYearlyUrl || ""),
    checkoutLifetimeUrl: String(doc.checkoutLifetimeUrl || ""),
    cryptoReceiveAddress: String(doc.cryptoReceiveAddress || ""),
    usdcMint: String(doc.usdcMint || ""),
    priceMonthlyUsd: Number(doc.priceMonthlyUsd),
    priceYearlyUsd: Number(doc.priceYearlyUsd),
    priceLifetimeUsd: Number(doc.priceLifetimeUsd),
    platformFeeBps: Number(doc.platformFeeBps),
    proTradeAllowance: Number(doc.proTradeAllowance),
    trialDays: Number(doc.trialDays),
    offers: (doc.offers || []).map(offerRow),
  });
}

function verifyMessage(message: string, signature: string | undefined): boolean {
  if (!signature) return false;
  try {
    const raw = Buffer.from(MONETIZATION_PUBLIC_KEY_B64, "base64");
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function readSignedAllowance(report: (surface: string) => void = () => undefined): number {
  try {
    const doc = JSON.parse(readFileSync(new URL("../monetization.json", import.meta.url), "utf8"));
    if (doc.adsenseClient !== ADSENSE_CLIENT || !verifyMessage(canonicalMonetization(doc), doc.signature)) {
      report("desk");
      return 0;
    }
    return Number(doc.proTradeAllowance);
  } catch {
    report("desk");
    return 0;
  }
}

export function feeDisclosure(bps: number): string {
  return `Platform fee ${(bps / 100).toFixed(1)}%`;
}

/** Null when the signature does not verify. Callers must not invent a fee. */
export function readPlatformFee(): { bps: number; receiveAddress: string } | null {
  try {
    const doc = JSON.parse(readFileSync(new URL("../monetization.json", import.meta.url), "utf8"));
    if (!verifyMessage(canonicalMonetization(doc), doc.signature)) return null;
    const bps = Number(doc.platformFeeBps);
    const receiveAddress = String(doc.cryptoReceiveAddress || "");
    if (!Number.isInteger(bps) || bps < 0 || bps > 100 || receiveAddress.length < 32) return null;
    return { bps, receiveAddress };
  } catch {
    return null;
  }
}

export function signedCheckoutUrl(): string {
  try {
    const doc = JSON.parse(readFileSync(new URL("../monetization.json", import.meta.url), "utf8"));
    if (!verifyMessage(canonicalMonetization(doc), doc.signature)) return "";
    return String(doc.checkoutUrl || "");
  } catch {
    return "";
  }
}
