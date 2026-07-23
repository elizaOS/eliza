/**
 * Validates the production iOS association response before native release.
 * Origin mode is the synchronous deploy/rollback gate; Apple CDN mode is a
 * separate readiness observation because Apple's cache refresh is asynchronous.
 * Capture mode lets edge tests exercise the strict origin response contract.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const AASA_URL =
  "https://eliza.app/.well-known/apple-app-site-association";
export const APPLE_CDN_AASA_URL =
  "https://app-site-association.cdn-apple.com/a/v1/eliza.app";
export const MAX_AASA_BYTES = 128 * 1024;
export const RELEASE_APP_ID = "25877RY2EH.ai.elizaos.app";
export const RELEASE_WEBCREDENTIAL_APPS = [RELEASE_APP_ID];
export const RELEASE_APPLINK_COMPONENTS = [
  { "/": "/auth/callback" },
  { "/": "/chat*" },
  { "/": "/wallet" },
  { "/": "/inventory" },
  { "/": "/messages*" },
  { "/": "/contacts" },
  { "/": "/phone*" },
  { "/": "/browser" },
  { "/": "/settings*" },
  { "/": "/connect*" },
  { "/": "/share*" },
  { "/": "/api/*", exclude: true },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultCanonicalPath = resolve(
  scriptDir,
  "../edge/apple-app-site-association.json",
);

function parseHeaders(headersText) {
  const headers = new Map();
  for (const line of headersText.replaceAll("\r", "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.set(
        line.slice(0, separator).toLowerCase(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  return headers;
}

function validateAssociationSemantics(association) {
  const failures = [];
  const details = association?.applinks?.details;
  if (!Array.isArray(details) || details.length !== 1) {
    failures.push(
      "applinks.details must contain exactly one release app entry",
    );
  }
  const app = Array.isArray(details) ? details[0] : undefined;
  if (!isDeepStrictEqual(app?.appIDs, [RELEASE_APP_ID])) {
    failures.push(`applinks does not bind exactly ${RELEASE_APP_ID}`);
  }
  if (!isDeepStrictEqual(app?.components, RELEASE_APPLINK_COMPONENTS)) {
    failures.push(
      "applinks components differ from the reviewed legacy routes plus /auth/callback",
    );
  }
  if (
    !app ||
    !isDeepStrictEqual(Object.keys(app).sort(), ["appIDs", "components"])
  ) {
    failures.push("release app entry contains unreviewed fields");
  }
  if (
    !association?.applinks ||
    !isDeepStrictEqual(Object.keys(association.applinks).sort(), ["details"])
  ) {
    failures.push("applinks contains unreviewed fields");
  }
  if (
    !association?.webcredentials ||
    !isDeepStrictEqual(Object.keys(association.webcredentials).sort(), ["apps"])
  ) {
    failures.push("webcredentials contains unreviewed fields");
  }
  if (
    !isDeepStrictEqual(
      association?.webcredentials?.apps,
      RELEASE_WEBCREDENTIAL_APPS,
    )
  ) {
    failures.push(`webcredentials does not bind exactly ${RELEASE_APP_ID}`);
  }
  if (
    !association ||
    typeof association !== "object" ||
    Array.isArray(association) ||
    !isDeepStrictEqual(Object.keys(association).sort(), [
      "applinks",
      "webcredentials",
    ])
  ) {
    failures.push(
      "association contains unreviewed top-level services or fields",
    );
  }
  return failures;
}

function findPbxObjects(project, predicate) {
  const objectPattern =
    /^\t\t([A-Za-z0-9]+) \/\* ([^\n]+) \*\/ = \{\n([\s\S]*?)^\t\t\};/gm;
  const objects = [];
  for (const match of project.matchAll(objectPattern)) {
    const object = { id: match[1], label: match[2], body: match[3] };
    if (predicate(object)) objects.push(object);
  }
  return objects;
}

function readBuildSetting(body, setting) {
  const matches = [
    ...body.matchAll(new RegExp(`^\\s*${setting} = ([^;]+);$`, "gm")),
  ];
  return matches.length === 1
    ? matches[0][1].replaceAll('"', "").trim()
    : undefined;
}

export function validateReleaseAppConfiguration({ project, entitlements }) {
  const failures = [];
  const appTargets = findPbxObjects(
    project,
    ({ label, body }) =>
      label === "App" &&
      body.includes("isa = PBXNativeTarget;") &&
      /^\s*name = App;$/m.test(body),
  );
  const appTarget = appTargets.length === 1 ? appTargets[0] : undefined;
  const configurationListId = appTarget?.body.match(
    /^\s*buildConfigurationList = ([A-Za-z0-9]+) /m,
  )?.[1];
  const configurationLists = configurationListId
    ? findPbxObjects(project, ({ id }) => id === configurationListId)
    : [];
  const configurationList =
    configurationLists.length === 1 ? configurationLists[0] : undefined;
  const releaseConfigurationReferences = configurationList
    ? [
        ...configurationList.body.matchAll(
          /^\s*([A-Za-z0-9]+) \/\* Release \*\/,?$/gm,
        ),
      ]
    : [];
  const releaseConfigurationId =
    releaseConfigurationReferences.length === 1
      ? releaseConfigurationReferences[0][1]
      : undefined;
  const releaseConfigurations = releaseConfigurationId
    ? findPbxObjects(
        project,
        ({ id, label, body }) =>
          id === releaseConfigurationId &&
          label === "Release" &&
          body.includes("isa = XCBuildConfiguration;") &&
          /^\s*name = Release;$/m.test(body),
      )
    : [];
  const releaseConfiguration =
    releaseConfigurations.length === 1 ? releaseConfigurations[0] : undefined;

  if (!appTarget || !configurationList || !releaseConfiguration) {
    failures.push(
      "Xcode App/Release target configuration could not be resolved",
    );
  } else {
    const requiredSettings = new Map([
      ["CODE_SIGN_ENTITLEMENTS", "App/App.entitlements"],
      ["DEVELOPMENT_TEAM", "25877RY2EH"],
      ["PRODUCT_BUNDLE_IDENTIFIER", "ai.elizaos.app"],
    ]);
    for (const [setting, expected] of requiredSettings) {
      const actual = readBuildSetting(releaseConfiguration.body, setting);
      if (actual !== expected) {
        failures.push(
          `Xcode App/Release ${setting} must be ${expected}, received ${actual || "<missing or repeated>"}`,
        );
      }
    }
  }

  const domainBlocks = [
    ...entitlements.matchAll(
      /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>([\s\S]*?)<\/array>/g,
    ),
  ];
  const domainsBody =
    domainBlocks.length === 1 ? domainBlocks[0][1] : undefined;
  const domains = domainsBody
    ? [...domainsBody.matchAll(/<string>([^<]+)<\/string>/g)].map(
        (match) => match[1],
      )
    : [];
  if (
    !isDeepStrictEqual(domains, [
      "applinks:eliza.app",
      "webcredentials:eliza.app",
    ])
  ) {
    failures.push(
      "App entitlements must contain exactly the applinks and webcredentials eliza.app domains",
    );
  }
  return failures;
}

function parseAssociation(body, label, failures) {
  try {
    return JSON.parse(body);
  } catch (error) {
    // error-policy:J3 Network JSON remains invalid until its exact contract is parsed.
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label} is not valid JSON: ${message}`);
    return undefined;
  }
}

export function validateAasaResponse({ status, headersText, body, canonical }) {
  const failures = [];
  const headers = parseHeaders(headersText);
  const contentType = (headers.get("content-type") || "").toLowerCase();
  const cacheControl = (headers.get("cache-control") || "").toLowerCase();

  if (String(status) !== "200")
    failures.push(`expected HTTP 200, received ${status}`);
  if (contentType !== "application/json") {
    failures.push(
      `unexpected Content-Type: ${headers.get("content-type") || "<missing>"}`,
    );
  }
  if (cacheControl !== "no-store") {
    failures.push(
      `Cache-Control is not no-store: ${headers.get("cache-control") || "<missing>"}`,
    );
  }
  if (
    (headers.get("x-content-type-options") || "").toLowerCase() !== "nosniff"
  ) {
    failures.push(
      `X-Content-Type-Options is not nosniff: ${headers.get("x-content-type-options") || "<missing>"}`,
    );
  }
  if (headers.has("location"))
    failures.push("response redirected unexpectedly");
  if (Buffer.byteLength(body, "utf8") > MAX_AASA_BYTES) {
    failures.push(`response exceeds Apple's ${MAX_AASA_BYTES}-byte limit`);
  }
  if (body !== canonical) {
    failures.push("live response bytes differ from the tracked AASA source");
  }

  const association = parseAssociation(body, "response", failures);
  if (association) failures.push(...validateAssociationSemantics(association));

  return failures;
}

export function validateAppleCdnAasaResponse({
  status,
  headersText,
  body,
  canonical,
}) {
  const failures = [];
  const headers = parseHeaders(headersText);
  const rawContentType = headers.get("content-type") || "";
  const mediaType = rawContentType.split(";", 1)[0].trim().toLowerCase();

  if (String(status) !== "200")
    failures.push(`expected HTTP 200, received ${status}`);
  if (mediaType !== "application/json") {
    failures.push(`unexpected Content-Type: ${rawContentType || "<missing>"}`);
  }
  if (headers.has("location"))
    failures.push("response redirected unexpectedly");
  if (Buffer.byteLength(body, "utf8") > MAX_AASA_BYTES) {
    failures.push(`response exceeds Apple's ${MAX_AASA_BYTES}-byte limit`);
  }
  if (headers.get("apple-from") !== AASA_URL) {
    failures.push(
      `Apple-From must be ${AASA_URL}, received ${headers.get("apple-from") || "<missing>"}`,
    );
  }
  if (headers.get("apple-origin-format") !== "json") {
    failures.push(
      `Apple-Origin-Format must be json, received ${headers.get("apple-origin-format") || "<missing>"}`,
    );
  }
  for (const [name, value] of headers) {
    if (name.startsWith("apple-failure-")) {
      failures.push(`Apple CDN reported ${name}: ${value || "<empty>"}`);
    }
  }
  if ((headers.get("apple-try-direct") || "").toLowerCase() === "true") {
    failures.push("Apple-Try-Direct must not be true");
  }

  const association = parseAssociation(body, "Apple CDN response", failures);
  const canonicalAssociation = parseAssociation(
    canonical,
    "tracked AASA source",
    failures,
  );
  if (
    association &&
    canonicalAssociation &&
    !isDeepStrictEqual(association, canonicalAssociation)
  ) {
    failures.push("Apple CDN JSON differs from the tracked AASA source");
  }
  if (association) failures.push(...validateAssociationSemantics(association));

  return failures;
}

export function validateAasaResponseLocation({
  effectiveUrl,
  expectedUrl = AASA_URL,
  redirected = false,
}) {
  const failures = [];
  if (effectiveUrl !== expectedUrl) {
    failures.push(
      `expected exact AASA URL ${expectedUrl}, received ${effectiveUrl || "<missing>"}`,
    );
  }
  if (redirected) failures.push("response followed a redirect unexpectedly");
  return failures;
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new Error(`response has invalid Content-Length: ${declaredLength}`);
    }
    if (BigInt(declaredLength) > BigInt(maxBytes)) {
      throw new Error(`response exceeds Apple's ${maxBytes}-byte limit`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) throw new Error("response body stream returned no bytes");
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds Apple's ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function headersToText(headers) {
  return [...headers.entries()]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

async function fetchAasaResponse({ url, fetchImpl, timeoutMs, maxBytes }) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: abort.signal,
      headers: { accept: "application/json" },
    });
    return {
      response,
      body: await readBoundedBody(response, maxBytes),
    };
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
}

export async function fetchAndValidateOriginAasa({
  url = AASA_URL,
  canonical,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maxBytes = MAX_AASA_BYTES,
}) {
  const { response, body } = await fetchAasaResponse({
    url,
    fetchImpl,
    timeoutMs,
    maxBytes,
  });
  return [
    ...validateAasaResponseLocation({
      effectiveUrl: response.url,
      expectedUrl: url,
      redirected: response.redirected,
    }),
    ...validateAasaResponse({
      status: response.status,
      headersText: headersToText(response.headers),
      body,
      canonical,
    }),
  ];
}

export async function fetchAndValidateAppleCdnAasa({
  url = APPLE_CDN_AASA_URL,
  canonical,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maxBytes = MAX_AASA_BYTES,
}) {
  const { response, body } = await fetchAasaResponse({
    url,
    fetchImpl,
    timeoutMs,
    maxBytes,
  });
  return [
    ...validateAasaResponseLocation({
      effectiveUrl: response.url,
      expectedUrl: url,
      redirected: response.redirected,
    }),
    ...validateAppleCdnAasaResponse({
      status: response.status,
      headersText: headersToText(response.headers),
      body,
      canonical,
    }),
  ];
}

async function collectLiveFailures(label, operation) {
  try {
    return (await operation()).map((failure) => `${label}: ${failure}`);
  } catch (error) {
    // error-policy:J1 Each endpoint translates transport failure into an explicit gate result.
    return [
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

export async function fetchAndValidateLiveAasa({
  originUrl = AASA_URL,
  cdnUrl = APPLE_CDN_AASA_URL,
  canonical,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maxBytes = MAX_AASA_BYTES,
}) {
  const [originFailures, cdnFailures] = await Promise.all([
    collectLiveFailures("origin", () =>
      fetchAndValidateOriginAasa({
        url: originUrl,
        canonical,
        fetchImpl,
        timeoutMs,
        maxBytes,
      }),
    ),
    collectLiveFailures("Apple CDN", () =>
      fetchAndValidateAppleCdnAasa({
        url: cdnUrl,
        canonical,
        fetchImpl,
        timeoutMs,
        maxBytes,
      }),
    ),
  ]);
  return [...originFailures, ...cdnFailures];
}

function parseCliArgs(argv) {
  const values = new Map();
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith("--")) continue;
    const separator = arg.indexOf("=");
    if (separator < 0) {
      values.set(arg.slice(2), true);
    } else {
      values.set(arg.slice(2, separator), arg.slice(separator + 1));
    }
  }
  return values;
}

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function main() {
  const args = parseCliArgs(process.argv);
  const liveModes = ["live", "origin-live", "apple-cdn-live"].filter((mode) =>
    args.has(mode),
  );
  if (liveModes.length > 1) {
    throw new Error(
      "Use exactly one of --live, --origin-live, or --apple-cdn-live",
    );
  }
  const liveMode = liveModes[0];
  let failures = [];
  if (liveMode) {
    const attempts = Number(args.get("attempts") || 1);
    const retryMs = Number(args.get("retry-ms") || 10_000);
    const timeoutMs = Number(args.get("timeout-ms") || 20_000);
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new Error("--attempts must be a positive integer");
    }
    if (!Number.isInteger(retryMs) || retryMs < 0) {
      throw new Error("--retry-ms must be a non-negative integer");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("--timeout-ms must be a positive integer");
    }
    const canonicalPath = String(args.get("canonical") || defaultCanonicalPath);
    const canonical = readFileSync(canonicalPath, "utf8");
    const operation =
      liveMode === "origin-live"
        ? () =>
            collectLiveFailures("origin", () =>
              fetchAndValidateOriginAasa({ canonical, timeoutMs }),
            )
        : liveMode === "apple-cdn-live"
          ? () =>
              collectLiveFailures("Apple CDN", () =>
                fetchAndValidateAppleCdnAasa({ canonical, timeoutMs }),
              )
          : () => fetchAndValidateLiveAasa({ canonical, timeoutMs });
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        failures = await operation();
      } catch (error) {
        // error-policy:J1 Each network attempt becomes an explicit release-gate failure.
        failures = [error instanceof Error ? error.message : String(error)];
      }
      if (failures.length === 0) break;
      if (attempt < attempts) {
        console.error(
          `AASA verification attempt ${attempt} failed: ${failures.join("; ")}`,
        );
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
      }
    }
  } else {
    failures = validateAasaResponse({
      status: requiredEnvironmentValue("STATUS"),
      headersText: readFileSync(
        requiredEnvironmentValue("HEADERS_FILE"),
        "utf8",
      ),
      body: readFileSync(requiredEnvironmentValue("BODY_FILE"), "utf8"),
      canonical: readFileSync(
        requiredEnvironmentValue("CANONICAL_FILE"),
        "utf8",
      ),
    });
  }

  if (failures.length > 0) {
    console.error(failures.join("; "));
    process.exitCode = 1;
    return;
  }
  console.log(
    liveMode === "origin-live"
      ? "Live AASA origin is current and safe to leave deployed."
      : liveMode === "apple-cdn-live"
        ? "Apple's AASA CDN cache is current and usable by the release app."
        : liveMode === "live"
          ? "Live AASA origin and Apple CDN responses are current and usable by the release app."
          : "Captured AASA origin response matches the tracked release contract.",
  );
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  main().catch((error) => {
    // error-policy:J1 The CLI process translates unexpected gate failures to a nonzero exit.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
