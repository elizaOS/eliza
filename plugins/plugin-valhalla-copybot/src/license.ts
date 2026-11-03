import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { acceptedProduct, CHECKOUT_URL, checkoutLink, LEMON_PRODUCT_ID } from "./checkout.ts";

export const ACTIVATE_URL = "https://api.lemonsqueezy.com/v1/licenses/activate";
export const VALIDATE_URL = "https://api.lemonsqueezy.com/v1/licenses/validate";

export interface ProductConfig {
  PRO_PRICE: string;
  PRO_YEAR_PRICE: string;
  PRO_LAUNCH_PRICE: string;
  PRO_LAUNCH_SLOTS: number;
  LEMONSQUEEZY_CHECKOUT_URL: string;
  offlineGraceDays: number;
  proMonthlyCapUsd: number;
}

export const DEFAULT_PRODUCT: ProductConfig = {
  PRO_PRICE: "$9.99/mo launch price",
  PRO_YEAR_PRICE: "$149/year",
  PRO_LAUNCH_PRICE: "$9.99/mo",
  PRO_LAUNCH_SLOTS: 100,
  LEMONSQUEEZY_CHECKOUT_URL: CHECKOUT_URL,
  offlineGraceDays: 7,
  proMonthlyCapUsd: 20,
};

export interface LicenseRecord {
  licenseKey: string;
  instanceId: string;
  status: "active" | "inactive";
  validatedAt: number;
  expiresAt: number | null;
}

export type Online = "ok" | "invalid" | "down";

export function loadProductConfig(
  file = new URL("../product.config.json", import.meta.url)
): ProductConfig {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProductConfig>;
    return {
      PRO_PRICE: String(parsed.PRO_PRICE || DEFAULT_PRODUCT.PRO_PRICE),
      PRO_YEAR_PRICE: String(parsed.PRO_YEAR_PRICE || DEFAULT_PRODUCT.PRO_YEAR_PRICE),
      PRO_LAUNCH_PRICE: String(parsed.PRO_LAUNCH_PRICE || DEFAULT_PRODUCT.PRO_LAUNCH_PRICE),
      PRO_LAUNCH_SLOTS: Number(parsed.PRO_LAUNCH_SLOTS) || DEFAULT_PRODUCT.PRO_LAUNCH_SLOTS,
      LEMONSQUEEZY_CHECKOUT_URL: String(parsed.LEMONSQUEEZY_CHECKOUT_URL ?? "").trim(),
      offlineGraceDays: Number(parsed.offlineGraceDays) || DEFAULT_PRODUCT.offlineGraceDays,
      proMonthlyCapUsd: Number(parsed.proMonthlyCapUsd) || DEFAULT_PRODUCT.proMonthlyCapUsd,
    };
  } catch {
    return { ...DEFAULT_PRODUCT };
  }
}

export function tailKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length < 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function classifyLicenseBody(
  status: number,
  body: unknown
): {
  online: Online;
  instanceId: string;
  expiresAt: number | null;
} {
  if (status < 200 || status >= 500) return { online: "down", instanceId: "", expiresAt: null };
  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const license =
    row.license_key && typeof row.license_key === "object"
      ? (row.license_key as Record<string, unknown>)
      : {};
  const instance =
    row.instance && typeof row.instance === "object"
      ? (row.instance as Record<string, unknown>)
      : {};
  const flag = row.activated === true || row.valid === true;
  const state = String(license.status ?? "");
  const expires = license.expires_at == null ? null : Date.parse(String(license.expires_at));
  const expiresAt = expires != null && Number.isFinite(expires) ? expires : null;
  if (
    flag &&
    state === "active" &&
    acceptedProduct(body, LEMON_PRODUCT_ID) &&
    (expiresAt == null || expiresAt > Date.now())
  ) {
    return { online: "ok", instanceId: String(instance.id ?? ""), expiresAt };
  }
  return { online: "invalid", instanceId: "", expiresAt };
}

/** Network loss can keep a recent active license. A rejected key never stays Pro. */
export function decidePro(
  record: Pick<LicenseRecord, "status" | "validatedAt" | "expiresAt"> | null,
  online: Online,
  now: number,
  graceMs: number
): boolean {
  if (online === "invalid") return false;
  if (!record || record.status !== "active") return online === "ok";
  if (record.expiresAt != null && record.expiresAt <= now) return false;
  if (online === "ok") return true;
  return now - record.validatedAt <= graceMs;
}

async function postLicense(
  url: string,
  fields: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as unknown;
  return { status: response.status, body };
}

export class LicenseStore {
  constructor(
    readonly dataDir: string,
    readonly config = loadProductConfig()
  ) {}

  private file(): string {
    return path.join(this.dataDir, "license.json");
  }

  async read(): Promise<LicenseRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file(), "utf8")) as LicenseRecord;
      if (!parsed.licenseKey || !parsed.validatedAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async write(record: LicenseRecord): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file(), JSON.stringify(record), { mode: 0o600 });
  }

  view(record: LicenseRecord | null, pro: boolean): Record<string, unknown> {
    return {
      ok: true,
      pro,
      price: this.config.PRO_PRICE,
      checkoutReady: this.config.LEMONSQUEEZY_CHECKOUT_URL.length > 0,
      checkoutUrl: checkoutLink(this.config.LEMONSQUEEZY_CHECKOUT_URL, "windows"),
      portalCheckoutUrl: checkoutLink(this.config.LEMONSQUEEZY_CHECKOUT_URL, "portal"),
      tail: record ? tailKey(record.licenseKey) : "",
      graceDays: this.config.offlineGraceDays,
      note: "Pro is the paid plan. It is not a promise of profit. The desk still cannot send or withdraw.",
    };
  }

  async activate(
    key: string,
    instanceName: string,
    fetchImpl: typeof fetch = fetch
  ): Promise<Record<string, unknown>> {
    const licenseKey = key.trim();
    if (licenseKey.length < 8)
      return { ok: false, pro: false, error: "Enter the license key from the receipt." };
    try {
      const result = await postLicense(
        ACTIVATE_URL,
        { license_key: licenseKey, instance_name: instanceName.slice(0, 64) || "valhalla-desk" },
        fetchImpl
      );
      const judged = classifyLicenseBody(result.status, result.body);
      if (judged.online !== "ok")
        return { ok: false, pro: false, error: "That license was not accepted." };
      const record: LicenseRecord = {
        licenseKey,
        instanceId: judged.instanceId,
        status: "active",
        validatedAt: Date.now(),
        expiresAt: judged.expiresAt,
      };
      await this.write(record);
      return this.view(record, true);
    } catch {
      return { ok: false, pro: false, error: "The license service could not be reached." };
    }
  }

  async validate(
    fetchImpl: typeof fetch = fetch,
    now = Date.now()
  ): Promise<Record<string, unknown>> {
    const record = await this.read();
    const graceMs = this.config.offlineGraceDays * 24 * 60 * 60 * 1000;
    if (!record) return this.view(null, false);
    try {
      const result = await postLicense(
        VALIDATE_URL,
        { license_key: record.licenseKey, instance_id: record.instanceId },
        fetchImpl
      );
      const judged = classifyLicenseBody(result.status, result.body);
      if (judged.online === "ok") {
        const next = {
          ...record,
          status: "active" as const,
          validatedAt: now,
          expiresAt: judged.expiresAt,
        };
        await this.write(next);
        return this.view(next, true);
      }
      if (judged.online === "invalid") {
        const next = { ...record, status: "inactive" as const };
        await this.write(next);
        return this.view(next, false);
      }
      return this.view(record, decidePro(record, "down", now, graceMs));
    } catch {
      return this.view(record, decidePro(record, "down", now, graceMs));
    }
  }
}
