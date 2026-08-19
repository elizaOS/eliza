#!/usr/bin/env node
/**
 * Publishes one exact MSIX archive into an existing Microsoft Store app
 * submission and waits until Partner Center accepts the commit for ingestion.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_API_BASE = "https://manage.devcenter.microsoft.com/v1.0/my";
const STORE_RESOURCE = "https://manage.devcenter.microsoft.com";
const ACCEPTED_COMMIT_STATES = new Set([
  "PreProcessing",
  "Certification",
  "Release",
  "Publishing",
  "Published",
]);
const FAILED_COMMIT_STATES = new Set(["CommitFailed"]);
const WRITABLE_SUBMISSION_FIELDS = Object.freeze([
  "applicationCategory",
  "pricing",
  "visibility",
  "targetPublishDate",
  "listings",
  "hardwarePreferences",
  "automaticBackupEnabled",
  "canInstallOnRemovableMedia",
  "isGameDvrEnabled",
  "gamingOptions",
  "hasExternalInAppProducts",
  "meetAccessibilityGuidelines",
  "notesForCertification",
  "packageDeliveryOptions",
  "enterpriseLicensing",
  "allowMicrosoftDecideAppAvailabilityToFutureDeviceFamilies",
  "allowMicrosftDecideAppAvailabilityToFutureDeviceFamilies",
  "allowTargetFutureDeviceFamilies",
  "trailers",
]);

function requiredValue(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function requireArgument(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
}

function safeApiError(payload, fallback) {
  const candidate = payload?.message ?? payload?.code ?? fallback;
  return String(candidate).replace(/https?:\/\/\S+/g, "[redacted-url]");
}

async function requestJson(fetchImpl, url, options, operation) {
  const response = await fetchImpl(url, options);
  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    throw new Error(
      `${operation} failed with HTTP ${response.status}: ${safeApiError(payload, response.statusText)}`,
    );
  }
  return payload;
}

export function prepareSubmissionPayload(submission, packageFileName) {
  if (!submission || typeof submission !== "object") {
    throw new Error("Partner Center returned an invalid submission resource");
  }
  const normalizedPackage = basename(
    requiredValue(packageFileName, "package file name"),
  );
  const writable = Object.fromEntries(
    WRITABLE_SUBMISSION_FIELDS.filter((field) =>
      Object.hasOwn(submission, field),
    ).map((field) => [field, submission[field]]),
  );
  return {
    ...writable,
    targetPublishMode: "Immediate",
    applicationPackages: [
      {
        fileName: normalizedPackage,
        fileStatus: "PendingUpload",
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ],
  };
}

export function classifyCommitStatus(status) {
  if (ACCEPTED_COMMIT_STATES.has(status)) return "accepted";
  if (FAILED_COMMIT_STATES.has(status)) return "failed";
  return "pending";
}

export async function obtainStoreToken({
  tenantId,
  clientId,
  clientSecret,
  fetchImpl = fetch,
}) {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requiredValue(clientId, "MICROSOFT_STORE_CLIENT_ID"),
    client_secret: requiredValue(clientSecret, "MICROSOFT_STORE_CLIENT_SECRET"),
    resource: STORE_RESOURCE,
  });
  const payload = await requestJson(
    fetchImpl,
    `https://login.microsoftonline.com/${encodeURIComponent(requiredValue(tenantId, "MICROSOFT_STORE_TENANT_ID"))}/oauth2/token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: form,
    },
    "Microsoft Store token request",
  );
  return requiredValue(payload?.access_token, "Microsoft Store access token");
}

export async function submitMicrosoftStoreUpdate({
  applicationId,
  archivePath,
  packageFileName,
  tenantId,
  clientId,
  clientSecret,
  fetchImpl = fetch,
  readFileImpl = readFile,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs = 15_000,
  maxPolls = 80,
}) {
  const appId = encodeURIComponent(
    requiredValue(applicationId, "MICROSOFT_STORE_APPLICATION_ID"),
  );
  const archive = requiredValue(archivePath, "--archive");
  const packageName = basename(
    requiredValue(packageFileName, "--package-file-name"),
  );
  if (!archive.toLowerCase().endsWith(".zip")) {
    throw new Error("--archive must be the ZIP uploaded to Partner Center");
  }
  if (!packageName.toLowerCase().endsWith(".msix")) {
    throw new Error("--package-file-name must name the MSIX at the ZIP root");
  }

  const token = await obtainStoreToken({
    tenantId,
    clientId,
    clientSecret,
    fetchImpl,
  });
  const headers = { authorization: `Bearer ${token}` };
  const submissionsUrl = `${STORE_API_BASE}/applications/${appId}/submissions`;
  const created = await requestJson(
    fetchImpl,
    submissionsUrl,
    { method: "POST", headers },
    "Create Microsoft Store submission",
  );
  const submissionId = encodeURIComponent(
    requiredValue(String(created?.id ?? ""), "Microsoft Store submission ID"),
  );
  const uploadUrl = requiredValue(
    created?.fileUploadUrl,
    "Microsoft Store submission upload URL",
  );
  const submissionUrl = `${submissionsUrl}/${submissionId}`;
  const updated = prepareSubmissionPayload(created, packageName);

  await requestJson(
    fetchImpl,
    submissionUrl,
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(updated),
    },
    "Update Microsoft Store submission",
  );

  const archiveBytes = await readFileImpl(archive);
  const uploadResponse = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: {
      "content-type": "application/zip",
      "x-ms-blob-type": "BlockBlob",
    },
    body: archiveBytes,
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Upload Microsoft Store package archive failed with HTTP ${uploadResponse.status}`,
    );
  }

  await requestJson(
    fetchImpl,
    `${submissionUrl}/commit`,
    { method: "POST", headers },
    "Commit Microsoft Store submission",
  );

  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (poll > 0) await sleep(pollIntervalMs);
    const statusPayload = await requestJson(
      fetchImpl,
      `${submissionUrl}/status`,
      { method: "GET", headers },
      "Read Microsoft Store submission status",
    );
    const status = requiredValue(
      statusPayload?.status,
      "Microsoft Store submission status",
    );
    const classification = classifyCommitStatus(status);
    if (classification === "accepted") {
      return { submissionId: decodeURIComponent(submissionId), status };
    }
    if (classification === "failed") {
      const detail = safeApiError(
        statusPayload?.statusDetails?.errors?.[0],
        "Partner Center rejected the commit",
      );
      throw new Error(`Microsoft Store submission commit failed: ${detail}`);
    }
  }
  throw new Error(
    `Microsoft Store submission did not reach preprocessing after ${maxPolls} status checks`,
  );
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const result = await submitMicrosoftStoreUpdate({
    applicationId: env.MICROSOFT_STORE_APPLICATION_ID,
    archivePath: requireArgument(args, "--archive"),
    packageFileName: requireArgument(args, "--package-file-name"),
    tenantId: env.MICROSOFT_STORE_TENANT_ID,
    clientId: env.MICROSOFT_STORE_CLIENT_ID,
    clientSecret: env.MICROSOFT_STORE_CLIENT_SECRET,
  });
  console.log(
    `Microsoft Store submission ${result.submissionId} accepted for ingestion (${result.status}).`,
  );
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    // error-policy:J1 command boundary reports a fail-closed store submission
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
