/**
 * Exercises the Microsoft Store submission boundary with deterministic HTTP
 * doubles, including token scope, package replacement, commit, and failure.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyCommitStatus,
  prepareSubmissionPayload,
  submitMicrosoftStoreUpdate,
  validateStoreUploadUrl,
} from "../microsoft-store-submission.mjs";

const uploadUrl =
  "https://productingestionbin1.blob.core.windows.net/ingestion/archive.zip?sv=2024-01-01&se=2030-01-01&sp=w&sig=secret";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Microsoft Store submission", () => {
  test("replaces copied packages with one exact pending MSIX", () => {
    const payload = prepareSubmissionPayload(
      {
        id: "submission-1",
        targetPublishMode: "Manual",
        applicationPackages: [{ fileName: "old.msix", fileStatus: "Uploaded" }],
        listings: { "en-us": { baseListing: { title: "Eliza" } } },
      },
      "nested/Eliza-2.0.0.msix",
    );
    expect(payload.targetPublishMode).toBe("Immediate");
    expect(payload).not.toHaveProperty("id");
    expect(payload.listings).toEqual({
      "en-us": { baseListing: { title: "Eliza" } },
    });
    expect(payload.applicationPackages).toEqual([
      {
        fileName: "Eliza-2.0.0.msix",
        fileStatus: "PendingUpload",
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ]);
  });

  test("classifies Partner Center commit states", () => {
    expect(classifyCommitStatus("CommitStarted")).toBe("pending");
    expect(classifyCommitStatus("PreProcessing")).toBe("accepted");
    expect(classifyCommitStatus("Published")).toBe("accepted");
    expect(classifyCommitStatus("CommitFailed")).toBe("failed");
  });

  test("authenticates, uploads, commits, and waits for ingestion", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("login.microsoftonline.com")) {
        return jsonResponse({ access_token: "secret-token" });
      }
      if (
        url.endsWith("/applications/app-1/submissions") &&
        init.method === "POST"
      ) {
        return jsonResponse({
          id: "submission-1",
          fileUploadUrl: uploadUrl,
          listings: {},
          applicationPackages: [],
        });
      }
      if (url.endsWith("/submissions/submission-1") && init.method === "PUT") {
        return jsonResponse({ status: "PendingCommit" });
      }
      if (
        url.startsWith("https://productingestionbin1.blob.core.windows.net/")
      ) {
        return new Response("", { status: 201 });
      }
      if (url.endsWith("/commit")) return jsonResponse({});
      if (url.endsWith("/status")) {
        const statusCalls = calls.filter((call) =>
          call.url.endsWith("/status"),
        );
        return jsonResponse({
          status: statusCalls.length === 1 ? "CommitStarted" : "PreProcessing",
        });
      }
      return jsonResponse({ message: "unexpected request" }, 500);
    };

    const result = await submitMicrosoftStoreUpdate({
      applicationId: "app-1",
      archivePath: "release.zip",
      packageFileName: "Eliza-2.0.0.msix",
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "client-secret",
      fetchImpl,
      readFileImpl: async () => Buffer.from("zip bytes"),
      sleep: async () => {},
      pollIntervalMs: 0,
    });

    expect(result).toEqual({
      submissionId: "submission-1",
      status: "PreProcessing",
    });
    const tokenCall = calls[0];
    expect(String(tokenCall.init.body)).toContain(
      "resource=https%3A%2F%2Fmanage.devcenter.microsoft.com",
    );
    const updateCall = calls.find(
      (call) =>
        call.url.endsWith("/submission-1") && call.init.method === "PUT",
    );
    expect(
      JSON.parse(String(updateCall?.init.body)).applicationPackages,
    ).toEqual([
      {
        fileName: "Eliza-2.0.0.msix",
        fileStatus: "PendingUpload",
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ]);
    const uploadCall = calls.find((call) =>
      call.url.includes("productingestionbin1.blob.core.windows.net"),
    );
    expect(uploadCall).toBeDefined();
    expect(
      (uploadCall?.init.headers as Record<string, string> | undefined)?.[
        "x-ms-blob-type"
      ],
    ).toBe("BlockBlob");
  });

  test("fails closed when Partner Center rejects the commit", async () => {
    const fetchImpl = async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) {
        return jsonResponse({ access_token: "secret-token" });
      }
      if (
        url.endsWith("/applications/app-1/submissions") &&
        init.method === "POST"
      ) {
        return jsonResponse({
          id: "submission-1",
          fileUploadUrl: uploadUrl,
          listings: {},
        });
      }
      if (
        url.startsWith("https://productingestionbin1.blob.core.windows.net/")
      ) {
        return new Response("", { status: 201 });
      }
      if (url.endsWith("/status")) {
        return jsonResponse({
          status: "CommitFailed",
          statusDetails: { errors: [{ message: "Package identity mismatch" }] },
        });
      }
      return jsonResponse({});
    };

    await expect(
      submitMicrosoftStoreUpdate({
        applicationId: "app-1",
        archivePath: "release.zip",
        packageFileName: "Eliza-2.0.0.msix",
        tenantId: "tenant-1",
        clientId: "client-1",
        clientSecret: "client-secret",
        fetchImpl,
        readFileImpl: async () => Buffer.from("zip bytes"),
        sleep: async () => {},
      }),
    ).rejects.toThrow("Package identity mismatch");
  });

  test("rejects an untrusted upload URL before reading package bytes", async () => {
    expect(() =>
      validateStoreUploadUrl(
        "http://productingestionbin1.blob.core.windows.net/ingestion/a?sp=w&se=x&sig=x",
      ),
    ).toThrow(/writable HTTPS Azure Blob SAS URL/);
    expect(() =>
      validateStoreUploadUrl("https://attacker.example/upload?sp=w&se=x&sig=x"),
    ).toThrow(/writable HTTPS Azure Blob SAS URL/);
    expect(() =>
      validateStoreUploadUrl(
        "https://productingestionbin1.blob.core.windows.net/ingestion/a?sp=r&se=x&sig=x",
      ),
    ).toThrow(/writable HTTPS Azure Blob SAS URL/);

    let read = false;
    await expect(
      submitMicrosoftStoreUpdate({
        applicationId: "app-1",
        archivePath: "release.zip",
        packageFileName: "Eliza-2.0.0.msix",
        tenantId: "tenant-1",
        clientId: "client-1",
        clientSecret: "client-secret",
        fetchImpl: async (input, init = {}) => {
          const url = String(input);
          if (url.includes("login.microsoftonline.com")) {
            return jsonResponse({ access_token: "secret-token" });
          }
          if (init.method === "POST") {
            return jsonResponse({
              id: "submission-1",
              fileUploadUrl: "https://attacker.example/upload",
            });
          }
          return jsonResponse({});
        },
        readFileImpl: async () => {
          read = true;
          return Buffer.from("zip bytes");
        },
      }),
    ).rejects.toThrow(/writable HTTPS Azure Blob SAS URL/);
    expect(read).toBe(false);
  });
});
