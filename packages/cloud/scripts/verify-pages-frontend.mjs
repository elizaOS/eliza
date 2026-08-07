/**
 * Verifies that a Cloudflare Pages custom domain is serving the frontend bundle
 * that was just built by the deploy job. The check follows the live
 * `index.html` to its Vite entry chunk, compares that chunk name to the local
 * build output, and can require sentinel text that proves a specific user flow
 * is present in the served JavaScript.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

function normalizeBaseUrl(url) {
  const trimmed = `${url ?? ""}`.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed.endsWith("/") ? trimmed : `${trimmed}/`);
  } catch {
    // error-policy:J3 invalid user-provided URLs produce an explicit invalid report.
    return null;
  }
}

function normalizeAssetPath(asset) {
  const trimmed = `${asset ?? ""}`.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//.test(trimmed)) {
    try {
      return new URL(trimmed).pathname.replace(/^\/+/, "");
    } catch {
      // error-policy:J3 invalid asset URLs are ignored rather than treated as valid matches.
      return null;
    }
  }
  return trimmed.replace(/^\.?\//, "");
}

function extractEntryAssets(html) {
  if (typeof html !== "string") return [];
  const assets = new Set();
  for (const match of html.matchAll(
    /(?:src|href)=["']([^"']*assets\/index-[^"']+\.js)["']/g,
  )) {
    const asset = normalizeAssetPath(match[1]);
    if (asset) assets.add(asset);
  }
  return [...assets].sort();
}

function normalizeRequiredTexts(requiredTexts) {
  if (!Array.isArray(requiredTexts)) return [];
  return requiredTexts
    .map((text) => `${text ?? ""}`.trim())
    .filter((text) => text.length > 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    attempts = DEFAULT_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retrySleep = sleep,
    intervalMs = 2_000,
  } = options;
  let lastDetail = "not attempted";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const text = await response.text();
      if (response.ok) {
        clearTimeout(timeout);
        return { ok: true, text, detail: `HTTP ${response.status}` };
      }
      lastDetail = `HTTP ${response.status}: ${text.slice(0, 200)}`;
    } catch (err) {
      // error-policy:J1 boundary translation - network failures become verifier failure details.
      lastDetail = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await retrySleep(intervalMs);
  }
  return { ok: false, text: "", detail: lastDetail };
}

async function readExpectedAssets(distDir) {
  const indexPath = path.join(distDir, "index.html");
  const html = await readFile(indexPath, "utf8");
  return extractEntryAssets(html);
}

async function verifyPagesFrontendOnce(options) {
  const {
    servedUrl,
    distDir,
    requiredTexts = [],
    fetchImpl,
    fetchAttempts = DEFAULT_ATTEMPTS,
    retrySleep = sleep,
    fetchIntervalMs = 2_000,
  } = options;
  const baseUrl = normalizeBaseUrl(servedUrl);
  const required = normalizeRequiredTexts(requiredTexts);
  if (!baseUrl) {
    return {
      ok: false,
      reason: "invalid_served_url",
      detail: `Invalid served URL: ${servedUrl ?? ""}`,
      expectedAssets: [],
      servedAssets: [],
      requiredTextResults: [],
    };
  }

  const expectedAssets = await readExpectedAssets(distDir);
  const indexFetch = await fetchText(baseUrl.href, {
    fetchImpl,
    attempts: fetchAttempts,
    retrySleep,
    intervalMs: fetchIntervalMs,
  });
  if (!indexFetch.ok) {
    return {
      ok: false,
      reason: "index_unreachable",
      detail: indexFetch.detail,
      expectedAssets,
      servedAssets: [],
      requiredTextResults: [],
    };
  }

  const servedAssets = extractEntryAssets(indexFetch.text);
  const missingExpectedAssets = expectedAssets.filter(
    (asset) => !servedAssets.includes(asset),
  );
  if (expectedAssets.length === 0 || servedAssets.length === 0) {
    return {
      ok: false,
      reason: "entry_asset_missing",
      detail: `expected=${expectedAssets.join(",") || "-"} served=${servedAssets.join(",") || "-"}`,
      expectedAssets,
      servedAssets,
      missingExpectedAssets,
      requiredTextResults: [],
    };
  }
  if (missingExpectedAssets.length > 0) {
    return {
      ok: false,
      reason: "stale_entry_asset",
      detail: `Live index is serving ${servedAssets.join(", ")}; expected ${expectedAssets.join(", ")}`,
      expectedAssets,
      servedAssets,
      missingExpectedAssets,
      requiredTextResults: [],
    };
  }

  const bundleTexts = await Promise.all(
    expectedAssets.map(async (asset) => {
      const assetUrl = new URL(asset, baseUrl);
      const bundleFetch = await fetchText(assetUrl.href, {
        fetchImpl,
        attempts: fetchAttempts,
        retrySleep,
        intervalMs: fetchIntervalMs,
      });
      return { asset, ...bundleFetch };
    }),
  );
  const failedBundle = bundleTexts.find((bundle) => !bundle.ok);
  if (failedBundle) {
    return {
      ok: false,
      reason: "entry_asset_unreachable",
      detail: `${failedBundle.asset}: ${failedBundle.detail}`,
      expectedAssets,
      servedAssets,
      missingExpectedAssets,
      requiredTextResults: [],
    };
  }

  const combinedBundle = bundleTexts.map((bundle) => bundle.text).join("\n");
  const requiredTextResults = required.map((text) => ({
    text,
    present: combinedBundle.includes(text),
  }));
  const missingTexts = requiredTextResults
    .filter((result) => !result.present)
    .map((result) => result.text);
  if (missingTexts.length > 0) {
    return {
      ok: false,
      reason: "required_text_missing",
      detail: `Missing required text: ${missingTexts.join(", ")}`,
      expectedAssets,
      servedAssets,
      missingExpectedAssets,
      requiredTextResults,
    };
  }

  return {
    ok: true,
    reason: "ok",
    detail: `Live bundle matches ${expectedAssets.join(", ")}`,
    expectedAssets,
    servedAssets,
    missingExpectedAssets,
    requiredTextResults,
  };
}

export {
  extractEntryAssets,
  normalizeAssetPath,
  normalizeBaseUrl,
  verifyPagesFrontendOnce,
};
