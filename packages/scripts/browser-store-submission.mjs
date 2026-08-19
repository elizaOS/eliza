#!/usr/bin/env node
/**
 * Uploads immutable browser-extension packages to Chrome Web Store and
 * Microsoft Edge Add-ons, polling each asynchronous operation to completion.
 */

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CHROME_API_ROOT = "https://chromewebstore.googleapis.com";
const CHROME_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const EDGE_API_ROOT = "https://api.addons.microsoftedge.microsoft.com";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_POLL_ATTEMPTS = 40;

function requireArgument(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
}

function requirePattern(value, name, pattern) {
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format`);
  return value;
}

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function responseError(response, operation) {
  const body = (await response.text()).slice(0, 2_000);
  return new Error(`${operation} failed with HTTP ${response.status}: ${body}`);
}

async function requestJson(url, options, operation, fetchImpl = fetch) {
  const response = await fetchImpl(url, options);
  if (!response.ok) throw await responseError(response, operation);
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error });
  }
}

async function waitForTerminalState({
  operation,
  readState,
  pending,
  succeeded,
  getState = (result) => result?.status ?? result?.uploadState,
  attempts = DEFAULT_POLL_ATTEMPTS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await readState();
    const state = getState(result);
    if (succeeded.has(state)) return result;
    if (!pending.has(state)) {
      throw new Error(`${operation} failed in state ${String(state)}`);
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`${operation} did not finish after ${attempts} attempts`);
}

async function waitForChromeVersion({
  readStatus,
  expectedVersion,
  attempts = DEFAULT_POLL_ATTEMPTS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const status = await readStatus();
    if (status.takenDown || status.warned) {
      throw new Error(
        "Chrome Web Store item has an active policy enforcement state",
      );
    }
    const versions = [
      ...(status.submittedItemRevisionStatus?.distributionChannels ?? []),
      ...(status.publishedItemRevisionStatus?.distributionChannels ?? []),
    ].map((channel) => channel.crxVersion);
    if (versions.includes(expectedVersion)) return status;
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(
    `Chrome submission status does not contain exact version ${expectedVersion}`,
  );
}

export async function createChromeAccessToken(
  serviceAccount,
  fetchImpl = fetch,
) {
  if (
    serviceAccount?.type !== "service_account" ||
    typeof serviceAccount.client_email !== "string" ||
    typeof serviceAccount.private_key !== "string"
  ) {
    throw new Error("Chrome service account JSON is missing required fields");
  }
  const tokenUri =
    serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
  if (tokenUri !== "https://oauth2.googleapis.com/token") {
    throw new Error(
      "Chrome service account token_uri is not the Google OAuth token endpoint",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: CHROME_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const assertion = `${header}.${claims}.${base64Url(signer.sign(serviceAccount.private_key))}`;
  const response = await requestJson(
    tokenUri,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
    "Chrome OAuth token exchange",
    fetchImpl,
  );
  if (typeof response.access_token !== "string" || !response.access_token) {
    throw new Error("Chrome OAuth token exchange returned no access token");
  }
  return response.access_token;
}

export async function submitChromeExtension({
  packagePath,
  serviceAccountPath,
  publisherId,
  itemId,
  expectedVersion,
  publishType,
  fetchImpl = fetch,
  poll = {},
}) {
  requirePattern(publisherId, "Chrome publisher ID", /^[A-Za-z0-9_-]{8,128}$/u);
  requirePattern(itemId, "Chrome item ID", /^[a-p]{32}$/u);
  requirePattern(
    expectedVersion,
    "Chrome extension version",
    /^\d+(?:\.\d+){3}$/u,
  );
  if (!new Set(["DEFAULT_PUBLISH", "STAGED_PUBLISH"]).has(publishType)) {
    throw new Error(`Unsupported Chrome publish type: ${publishType}`);
  }
  const serviceAccount = JSON.parse(await readFile(serviceAccountPath, "utf8"));
  const packageBytes = await readFile(packagePath);
  const token = await createChromeAccessToken(serviceAccount, fetchImpl);
  const headers = { authorization: `Bearer ${token}` };
  const itemPath = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const upload = await requestJson(
    `${CHROME_API_ROOT}/upload/v2/${itemPath}:upload?uploadType=media`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/zip" },
      body: packageBytes,
    },
    "Chrome package upload",
    fetchImpl,
  );
  const readStatus = () =>
    requestJson(
      `${CHROME_API_ROOT}/v2/${itemPath}:fetchStatus`,
      { headers },
      "Chrome status fetch",
      fetchImpl,
    );
  const uploaded =
    upload.uploadState === "UPLOAD_SUCCESS"
      ? upload
      : await waitForTerminalState({
          operation: "Chrome package upload",
          readState: readStatus,
          pending: new Set(["UPLOAD_IN_PROGRESS"]),
          succeeded: new Set(["UPLOAD_SUCCESS"]),
          getState: (result) => result?.lastAsyncUploadState,
          ...poll,
        });
  const uploadedVersion = upload.crxVersion;
  if (uploadedVersion && uploadedVersion !== expectedVersion) {
    throw new Error(
      `Chrome uploaded version ${uploadedVersion} does not match ${expectedVersion}`,
    );
  }
  const published = await requestJson(
    `${CHROME_API_ROOT}/v2/${itemPath}:publish`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        publishType,
        skipReview: false,
        blockOnWarnings: true,
      }),
    },
    "Chrome publish submission",
    fetchImpl,
  );
  if (published.warningInfo?.warnings?.length) {
    throw new Error("Chrome publish response contained validation warnings");
  }
  const status = await waitForChromeVersion({
    readStatus,
    expectedVersion,
    ...poll,
  });
  return { upload: uploaded, publish: published, status };
}

function edgeHeaders(clientId, apiKey, extra = {}) {
  return {
    Authorization: `ApiKey ${apiKey}`,
    "X-ClientID": clientId,
    ...extra,
  };
}

function edgeOperationId(location) {
  if (!location)
    throw new Error("Edge operation response omitted the Location header");
  let value = location;
  if (/^https?:/u.test(location)) {
    const parsed = new URL(location);
    if (parsed.origin !== EDGE_API_ROOT) {
      throw new Error("Edge operation Location used an unexpected origin");
    }
    value = parsed.pathname.split("/").filter(Boolean).at(-1);
  }
  return requirePattern(value, "Edge operation ID", /^[A-Za-z0-9-]{8,128}$/u);
}

async function edgeAccepted(url, options, operation, fetchImpl) {
  const response = await fetchImpl(url, options);
  if (response.status !== 202) throw await responseError(response, operation);
  return edgeOperationId(response.headers.get("location"));
}

export async function submitEdgeExtension({
  packagePath,
  productId,
  clientId,
  apiKey,
  notes,
  fetchImpl = fetch,
  poll = {},
}) {
  requirePattern(
    productId,
    "Edge product ID",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  if (!clientId || !apiKey)
    throw new Error("Edge Client ID and API key are required");
  const productPath = `/v1/products/${encodeURIComponent(productId)}`;
  const packageBytes = await readFile(packagePath);
  const uploadId = await edgeAccepted(
    `${EDGE_API_ROOT}${productPath}/submissions/draft/package`,
    {
      method: "POST",
      headers: edgeHeaders(clientId, apiKey, {
        "content-type": "application/zip",
      }),
      body: packageBytes,
    },
    "Edge package upload",
    fetchImpl,
  );
  const readOperation = (path, operation) => () =>
    requestJson(
      `${EDGE_API_ROOT}${path}`,
      { headers: edgeHeaders(clientId, apiKey) },
      operation,
      fetchImpl,
    );
  const upload = await waitForTerminalState({
    operation: "Edge package upload",
    readState: readOperation(
      `${productPath}/submissions/draft/package/operations/${encodeURIComponent(uploadId)}`,
      "Edge upload status",
    ),
    pending: new Set(["InProgress"]),
    succeeded: new Set(["Succeeded"]),
    ...poll,
  });
  const publishId = await edgeAccepted(
    `${EDGE_API_ROOT}${productPath}/submissions`,
    {
      method: "POST",
      headers: edgeHeaders(clientId, apiKey, {
        "content-type": "application/json",
      }),
      body: JSON.stringify({ notes }),
    },
    "Edge publish submission",
    fetchImpl,
  );
  const publish = await waitForTerminalState({
    operation: "Edge publish submission",
    readState: readOperation(
      `${productPath}/submissions/operations/${encodeURIComponent(publishId)}`,
      "Edge publishing status",
    ),
    pending: new Set(["InProgress"]),
    succeeded: new Set(["Succeeded"]),
    ...poll,
  });
  return { upload, publish };
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (command === "chrome") {
    const result = await submitChromeExtension({
      packagePath: requireArgument(args, "--package"),
      serviceAccountPath: requireArgument(args, "--service-account"),
      publisherId: requireArgument(args, "--publisher-id"),
      itemId: requireArgument(args, "--item-id"),
      expectedVersion: requireArgument(args, "--version"),
      publishType: requireArgument(args, "--publish-type"),
    });
    console.log(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (command === "edge") {
    const result = await submitEdgeExtension({
      packagePath: requireArgument(args, "--package"),
      productId: requireArgument(args, "--product-id"),
      clientId: requireArgument(args, "--client-id"),
      apiKey: requireArgument(args, "--api-key"),
      notes: requireArgument(args, "--notes"),
    });
    console.log(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  throw new Error("Expected browser store command: chrome or edge");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    // error-policy:J1 command boundary reports store API failures without fabricated success
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
