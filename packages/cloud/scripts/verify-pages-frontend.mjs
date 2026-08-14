/**
 * Verifies that a Cloudflare Pages custom domain is serving the frontend bundle
 * that was just built by the deploy job. The check follows the live
 * `index.html` to its Vite entry chunk, then compares every emitted JavaScript
 * script with the local build byte-for-byte. Required sentinel text is searched
 * incrementally across the complete emitted graph so code-split user flows
 * remain provable without retaining the entire application in memory.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT_ASSET_FETCHES = 16;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_JAVASCRIPT_ASSETS = 2_048;
const MAX_TOTAL_JAVASCRIPT_BYTES = 128 * 1024 * 1024;

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

async function fetchText(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_INDEX_BYTES,
    signal,
  } = options;
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  let detachCancellation = () => {};
  const cancellationFailure = signal
    ? new Promise((_, reject) => {
        const cancel = () => {
          cancelled = true;
          controller.abort(signal.reason);
          reject(new Error("request cancelled after sibling failure"));
        };
        if (signal.aborted) cancel();
        else {
          signal.addEventListener("abort", cancel, { once: true });
          detachCancellation = () =>
            signal.removeEventListener("abort", cancel);
        }
      })
    : null;
  const readResponse = async () => {
    const response = await fetchImpl(url, { signal: controller.signal });
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      controller.abort();
      return {
        ok: false,
        bytes: null,
        text: "",
        limitExceeded: true,
        cancelled: false,
        timedOut: false,
        detail: `response declares ${contentLength} bytes; limit is ${maxBytes}`,
      };
    }
    if (!response.ok) {
      controller.abort();
      return {
        ok: false,
        bytes: null,
        text: "",
        limitExceeded: false,
        cancelled: false,
        timedOut: false,
        detail: `HTTP ${response.status}`,
      };
    }

    let bytes;
    if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          controller.abort();
          return {
            ok: false,
            bytes: null,
            text: "",
            limitExceeded: true,
            cancelled: false,
            timedOut: false,
            detail: `response exceeded ${maxBytes} bytes`,
          };
        }
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, totalBytes);
    } else {
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        controller.abort();
        return {
          ok: false,
          bytes: null,
          text: "",
          limitExceeded: true,
          cancelled: false,
          timedOut: false,
          detail: `response returned ${bytes.length} bytes; limit is ${maxBytes}`,
        };
      }
    }
    const text = bytes.toString("utf8");
    return {
      ok: true,
      bytes,
      text,
      limitExceeded: false,
      cancelled: false,
      timedOut: false,
      detail: `HTTP ${response.status}`,
    };
  };
  try {
    return await Promise.race(
      cancellationFailure
        ? [readResponse(), timeoutFailure, cancellationFailure]
        : [readResponse(), timeoutFailure],
    );
  } catch (err) {
    // error-policy:J1 boundary translation - network failures become verifier failure details.
    return {
      ok: false,
      bytes: null,
      text: "",
      limitExceeded: false,
      cancelled,
      timedOut,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
    detachCancellation();
  }
}

async function readExpectedAssets(distDir) {
  const indexPath = path.join(distDir, "index.html");
  const html = await readFile(indexPath, "utf8");
  return extractEntryAssets(html);
}

async function readJavaScriptAssets(distDir) {
  const pending = [""];
  const assets = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const relativeDir = pending.pop();
    const entries = await readdir(path.join(distDir, relativeDir), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const size = (await stat(path.join(distDir, relativePath))).size;
        assets.push({ path: relativePath, size });
        totalBytes += size;
      }
    }
  }
  assets.sort((left, right) => left.path.localeCompare(right.path));
  return { assets, totalBytes };
}

async function verifyPagesFrontendOnce(options) {
  const {
    servedUrl,
    distDir,
    requiredTexts = [],
    fetchImpl,
    fetchTimeoutMs = DEFAULT_TIMEOUT_MS,
    verificationTimeoutMs = DEFAULT_VERIFICATION_TIMEOUT_MS,
  } = options;
  const deadlineAt = Date.now() + verificationTimeoutMs;
  const remainingMs = () => Math.max(0, deadlineAt - Date.now());
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
  const javascriptManifest = await readJavaScriptAssets(distDir);
  const javascriptAssets = javascriptManifest.assets;
  if (
    javascriptAssets.length > MAX_JAVASCRIPT_ASSETS ||
    javascriptManifest.totalBytes > MAX_TOTAL_JAVASCRIPT_BYTES
  ) {
    return {
      ok: false,
      reason: "asset_budget_exceeded",
      detail: `Local dist has ${javascriptAssets.length} JavaScript assets totaling ${javascriptManifest.totalBytes} bytes; limits are ${MAX_JAVASCRIPT_ASSETS} assets and ${MAX_TOTAL_JAVASCRIPT_BYTES} bytes`,
      expectedAssets,
      servedAssets: [],
      requiredTextResults: [],
    };
  }
  if (remainingMs() === 0) {
    return {
      ok: false,
      reason: "verification_timeout",
      detail: `Verification exceeded ${verificationTimeoutMs}ms before the live index fetch`,
      expectedAssets,
      servedAssets: [],
      requiredTextResults: [],
    };
  }
  const indexFetch = await fetchText(baseUrl.href, {
    fetchImpl,
    timeoutMs: Math.min(fetchTimeoutMs, remainingMs()),
    maxBytes: MAX_INDEX_BYTES,
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
  if (
    expectedAssets.length === 0 ||
    servedAssets.length === 0 ||
    javascriptAssets.length === 0
  ) {
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
  const missingLocalEntryAssets = expectedAssets.filter(
    (asset) => !javascriptAssets.some((entry) => entry.path === asset),
  );
  if (missingLocalEntryAssets.length > 0) {
    return {
      ok: false,
      reason: "entry_asset_missing",
      detail: `Local dist is missing entry asset(s): ${missingLocalEntryAssets.join(", ")}`,
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

  const requiredTextResults = required.map((text) => ({
    text,
    present: false,
  }));
  for (
    let offset = 0;
    offset < javascriptAssets.length;
    offset += MAX_CONCURRENT_ASSET_FETCHES
  ) {
    const batch = javascriptAssets.slice(
      offset,
      offset + MAX_CONCURRENT_ASSET_FETCHES,
    );
    if (remainingMs() === 0) {
      return {
        ok: false,
        reason: "verification_timeout",
        detail: `Verification exceeded ${verificationTimeoutMs}ms after ${offset} JavaScript assets`,
        expectedAssets,
        servedAssets,
        missingExpectedAssets,
        requiredTextResults,
      };
    }
    const deadlineBounded = remainingMs() <= fetchTimeoutMs;
    const batchTimeoutMs = Math.min(fetchTimeoutMs, remainingMs());
    const batchController = new AbortController();
    let firstBatchFailure = null;
    const batchResults = await Promise.all(
      batch.map(async (asset) => {
        const assetUrl = new URL(asset.path, baseUrl);
        const [localBytes, bundleFetch] = await Promise.all([
          readFile(path.join(distDir, asset.path)),
          fetchText(assetUrl.href, {
            fetchImpl,
            timeoutMs: batchTimeoutMs,
            maxBytes: asset.size,
            signal: batchController.signal,
          }),
        ]);
        const bundle = { asset: asset.path, localBytes, ...bundleFetch };
        let failure = null;
        if (!bundle.ok && !bundle.limitExceeded && !bundle.cancelled) {
          failure = {
            reason:
              bundle.timedOut && deadlineBounded
                ? "verification_timeout"
                : "javascript_asset_unreachable",
            bundle,
          };
        } else if (
          bundle.limitExceeded ||
          (bundle.ok && !bundle.localBytes.equals(bundle.bytes))
        ) {
          failure = { reason: "asset_bytes_mismatch", bundle };
        }
        if (failure && firstBatchFailure === null) {
          firstBatchFailure = failure;
          batchController.abort();
        }
        return bundle;
      }),
    );
    if (firstBatchFailure?.reason === "verification_timeout") {
      return {
        ok: false,
        reason: "verification_timeout",
        detail: `Verification exceeded ${verificationTimeoutMs}ms while fetching ${firstBatchFailure.bundle.asset}`,
        expectedAssets,
        servedAssets,
        missingExpectedAssets,
        requiredTextResults,
      };
    }
    if (firstBatchFailure?.reason === "javascript_asset_unreachable") {
      return {
        ok: false,
        reason: "javascript_asset_unreachable",
        detail: `${firstBatchFailure.bundle.asset}: ${firstBatchFailure.bundle.detail}`,
        expectedAssets,
        servedAssets,
        missingExpectedAssets,
        requiredTextResults,
      };
    }
    if (firstBatchFailure?.reason === "asset_bytes_mismatch") {
      const mismatchedBundle = firstBatchFailure.bundle;
      const sizeDetail = mismatchedBundle.limitExceeded
        ? mismatchedBundle.detail
        : `${mismatchedBundle.bytes.length} live, ${mismatchedBundle.localBytes.length} local`;
      return {
        ok: false,
        reason: "asset_bytes_mismatch",
        detail: `${mismatchedBundle.asset}: live bytes differ from local dist (${sizeDetail})`,
        expectedAssets,
        servedAssets,
        missingExpectedAssets,
        requiredTextResults,
      };
    }
    for (const bundle of batchResults) {
      for (const result of requiredTextResults) {
        if (!result.present && bundle.text.includes(result.text)) {
          result.present = true;
        }
      }
    }
  }
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
    detail: `Live frontend matches ${javascriptAssets.length} emitted JavaScript asset(s) totaling ${javascriptManifest.totalBytes} bytes, including ${expectedAssets.join(", ")}`,
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
