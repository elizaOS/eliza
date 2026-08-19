/**
 * Exercises browser-store API boundaries with deterministic HTTP responses,
 * including exact version checks, async polling, and terminal failures.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  submitChromeExtension,
  submitEdgeExtension,
} from "../browser-store-submission.mjs";

const tempDirectories: string[] = [];

function tempFile(name: string, contents: string | Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "eliza-browser-store-"));
  tempDirectories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { status, headers });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Chrome Web Store submission", () => {
  test("exchanges service-account auth, uploads the exact version, and publishes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccountPath = tempFile(
      "service-account.json",
      JSON.stringify({
        type: "service_account",
        client_email: "release@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    );
    const packagePath = tempFile("extension.zip", "extension-bytes");
    const requests: Array<{ url: string; method: string }> = [];
    const responses = [
      jsonResponse({ access_token: "test-token" }),
      jsonResponse({ uploadState: "UPLOAD_IN_PROGRESS" }),
      jsonResponse({ lastAsyncUploadState: "UPLOAD_SUCCESS" }),
      jsonResponse({ state: "SUBMITTED_FOR_REVIEW" }),
      jsonResponse({
        submittedItemRevisionStatus: {
          distributionChannels: [{ crxVersion: "2.0.3.40007" }],
        },
      }),
    ];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    };

    const result = await submitChromeExtension({
      packagePath,
      serviceAccountPath,
      publisherId: "publisher_123456",
      itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expectedVersion: "2.0.3.40007",
      publishType: "STAGED_PUBLISH",
      fetchImpl,
      poll: { intervalMs: 0, sleep: async () => {} },
    });

    expect(requests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "GET",
      "POST",
      "GET",
    ]);
    expect(requests[1]?.url).toContain(":upload?uploadType=media");
    expect(requests[3]?.url).toContain(":publish");
    expect(result.publish.state).toBe("SUBMITTED_FOR_REVIEW");
  });

  test("rejects a store-reported version mismatch before publishing", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const serviceAccountPath = tempFile(
      "service-account.json",
      JSON.stringify({
        type: "service_account",
        client_email: "release@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    );
    const packagePath = tempFile("extension.zip", "extension-bytes");
    const responses = [
      jsonResponse({ access_token: "test-token" }),
      jsonResponse({ uploadState: "UPLOAD_SUCCESS", crxVersion: "1.0.0.0" }),
    ];
    const fetchImpl = async () => responses.shift() ?? jsonResponse({});

    await expect(
      submitChromeExtension({
        packagePath,
        serviceAccountPath,
        publisherId: "publisher_123456",
        itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedVersion: "2.0.3.60000",
        publishType: "DEFAULT_PUBLISH",
        fetchImpl,
      }),
    ).rejects.toThrow("does not match");
  });
});

describe("Microsoft Edge Add-ons submission", () => {
  test("waits for package processing before starting and completing publication", async () => {
    const packagePath = tempFile("extension.zip", "extension-bytes");
    const responses = [
      new Response("", {
        status: 202,
        headers: { location: "upload-operation" },
      }),
      jsonResponse({ status: "InProgress" }),
      jsonResponse({ status: "Succeeded" }),
      new Response("", {
        status: 202,
        headers: { location: "publish-operation" },
      }),
      jsonResponse({ status: "Succeeded" }),
    ];
    const fetchImpl = async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    };

    const result = await submitEdgeExtension({
      packagePath,
      productId: "d34f98f5-f9b7-42b1-bebb-98707202b21d",
      clientId: "client-id",
      apiKey: "api-key",
      notes: "Exact canonical release",
      fetchImpl,
      poll: { intervalMs: 0, sleep: async () => {} },
    });

    expect(result.upload.status).toBe("Succeeded");
    expect(result.publish.status).toBe("Succeeded");
  });

  test("fails closed when Edge returns a terminal rejection", async () => {
    const packagePath = tempFile("extension.zip", "extension-bytes");
    const responses = [
      new Response("", {
        status: 202,
        headers: { location: "upload-operation" },
      }),
      jsonResponse({ status: "Failed" }),
    ];
    const fetchImpl = async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    };

    await expect(
      submitEdgeExtension({
        packagePath,
        productId: "d34f98f5-f9b7-42b1-bebb-98707202b21d",
        clientId: "client-id",
        apiKey: "api-key",
        notes: "Exact canonical release",
        fetchImpl,
        poll: { intervalMs: 0, sleep: async () => {} },
      }),
    ).rejects.toThrow("failed in state Failed");
  });
});
