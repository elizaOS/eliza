/**
 * Drives the production googleapis client and corpus collector through a local
 * HTTP Gmail seam. Live OAuth/account proof remains a separate owner-gated run.
 */

import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GoogleAuthResolutionRequest,
  GoogleWorkspaceService,
} from "@elizaos/plugin-google";
import { Auth } from "googleapis";
import { afterEach, describe, expect, it } from "vitest";
import { collectGmailCorpus } from "./gmail.ts";

const NOW = new Date("2026-07-05T00:00:00.000Z");
const originalMockBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
let server: Server | undefined;

afterEach(async () => {
  if (originalMockBase === undefined) {
    delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  } else {
    process.env.ELIZA_MOCK_GOOGLE_BASE = originalMockBase;
  }
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

describe("Gmail corpus collector HTTP integration", () => {
  it("uses account OAuth, Gmail pagination, full MIME fetch, and attachment fetch", async () => {
    const requests: Array<{
      accountId: string;
      path: string;
      query: string;
    }> = [];
    let workListAttempts = 0;
    const attachment = Buffer.from("integration attachment", "utf8");
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const authorization = request.headers.authorization ?? "";
      const accountId = authorization.replace(/^Bearer\s+/i, "");
      requests.push({ accountId, path: url.pathname, query: url.search });
      response.setHeader("content-type", "application/json");

      if (url.pathname.endsWith("/users/me/profile")) {
        response.end(
          JSON.stringify({
            emailAddress: `${accountId}@example.test`,
            historyId: `profile-${accountId}`,
          }),
        );
        return;
      }
      if (url.pathname.endsWith("/users/me/messages")) {
        if (accountId === "work") {
          workListAttempts += 1;
          if (workListAttempts === 1) {
            response.statusCode = 429;
            response.end(
              JSON.stringify({
                error: { code: 429, message: "quota retry fixture" },
              }),
            );
            return;
          }
        }
        response.end(
          JSON.stringify({
            messages: [{ id: `${accountId}-message` }],
            resultSizeEstimate: 1,
          }),
        );
        return;
      }
      const attachmentMatch = url.pathname.match(
        /\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/,
      );
      if (attachmentMatch) {
        response.end(
          JSON.stringify({ data: attachment.toString("base64url") }),
        );
        return;
      }
      const messageMatch = url.pathname.match(
        /\/users\/me\/messages\/([^/]+)$/,
      );
      if (messageMatch) {
        const messageId = decodeURIComponent(messageMatch[1]);
        response.end(
          JSON.stringify({
            id: messageId,
            threadId: `${accountId}-thread`,
            historyId: `${accountId}-history`,
            internalDate: String(NOW.getTime() - 60_000),
            labelIds: ["INBOX"],
            snippet: `Snippet for ${accountId}`,
            payload: {
              mimeType: "multipart/mixed",
              headers: [
                { name: "Subject", value: `Subject for ${accountId}` },
                {
                  name: "From",
                  value: `Sender <sender-${accountId}@example.test>`,
                },
                {
                  name: "To",
                  value: `Owner <${accountId}@example.test>`,
                },
                { name: "Date", value: "Sun, 05 Jul 2026 00:00:00 GMT" },
              ],
              parts: [
                {
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from(`Body for ${accountId}`).toString(
                      "base64url",
                    ),
                  },
                },
                {
                  filename: `${accountId}.txt`,
                  mimeType: "text/plain",
                  body: {
                    attachmentId: `${accountId}-attachment`,
                    size: attachment.byteLength,
                  },
                },
              ],
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve, reject) => {
      server?.listen(0, "127.0.0.1", () => resolve());
      server?.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Gmail integration server did not bind a TCP port.");
    }
    process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${address.port}/`;

    const service = new GoogleWorkspaceService(undefined, {
      credentialResolver: {
        getAuthClient: async (request: GoogleAuthResolutionRequest) => {
          const client = new Auth.OAuth2Client();
          client.setCredentials({ access_token: request.accountId });
          return client;
        },
      },
    });
    const outputDir = await mkdtemp(path.join(tmpdir(), "gmail-http-"));
    const result = await collectGmailCorpus({
      source: service,
      accounts: [{ accountId: "work" }, { accountId: "home" }],
      outputDir,
      now: () => NOW,
    });

    expect(result.manifest.totals.messages).toBe(2);
    expect(result.accounts).toEqual([
      expect.objectContaining({ accountId: "work", writtenMessages: 1 }),
      expect.objectContaining({ accountId: "home", writtenMessages: 1 }),
    ]);
    expect(new Set(requests.map((request) => request.accountId))).toEqual(
      new Set(["work", "home"]),
    );
    expect(
      requests.filter((request) => request.path.endsWith("/users/me/messages")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          query: expect.stringContaining("includeSpamTrash=true"),
        }),
        expect.objectContaining({
          accountId: "home",
          query: expect.stringContaining("includeSpamTrash=true"),
        }),
      ]),
    );
    expect(workListAttempts).toBe(2);
    expect(
      requests.filter((request) => request.path.includes("/attachments/")),
    ).toHaveLength(2);
  });
});
