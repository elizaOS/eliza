/**
 * Browser workspace semantic-content admission tests use real UTF-8 response
 * streams and JSDOM documents to prove exact-boundary acceptance and atomic
 * rejection without returning partial text.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { isBrowserWorkspaceError } from "../browser-workspace-errors.ts";
import {
  assertBrowserWorkspaceContentAdmitted,
  BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES,
  readBrowserWorkspaceResponseText,
} from "../browser-workspace-helpers.ts";
import { buildBrowserWorkspaceDocumentSnapshotText } from "../browser-workspace-snapshots.ts";

function expectContentTooLarge(error: unknown, operation: string): void {
  expect(isBrowserWorkspaceError(error)).toBe(true);
  if (!isBrowserWorkspaceError(error)) {
    throw new Error("expected BrowserWorkspaceError");
  }
  expect(error.browserWorkspaceErrorCode).toBe("content_too_large");
  expect(error.operation).toBe(operation);
  expect(error.status).toBe(413);
}

describe("browser workspace UTF-8 content admission", () => {
  it("admits the exact ceiling and rejects one ASCII byte over", () => {
    expect(() =>
      assertBrowserWorkspaceContentAdmitted(
        "a".repeat(BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES),
        "route",
      ),
    ).not.toThrow();

    try {
      assertBrowserWorkspaceContentAdmitted(
        "a".repeat(BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES + 1),
        "route",
      );
      throw new Error("expected admission rejection");
    } catch (error) {
      expectContentTooLarge(error, "route");
    }
  });

  it("measures multibyte content as UTF-8 bytes", () => {
    const exact = "é".repeat(BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES / 2);
    expect(Buffer.byteLength(exact, "utf8")).toBe(
      BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES,
    );
    expect(() =>
      assertBrowserWorkspaceContentAdmitted(exact, "route"),
    ).not.toThrow();
    expect(() =>
      assertBrowserWorkspaceContentAdmitted(`${exact}é`, "route"),
    ).toThrowError(/UTF-8 maximum/);
  });

  it("rejects a streamed response atomically at one byte over", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES),
          );
          controller.enqueue(new Uint8Array([97]));
          controller.close();
        },
      }),
    );

    let returnedText: string | undefined;
    try {
      returnedText = await readBrowserWorkspaceResponseText(
        response,
        "live_response",
      );
      throw new Error("expected response rejection");
    } catch (error) {
      expect(returnedText).toBeUndefined();
      expectContentTooLarge(error, "live_response");
    }
  });

  it("accounts for body and form-control text in one snapshot budget", () => {
    const bodyLength = BROWSER_WORKSPACE_CONTENT_MAX_UTF8_BYTES - 5;
    const dom = new JSDOM(
      `<body>${"a".repeat(bodyLength)}<input id="x"></body>`,
    );
    const input = dom.window.document.querySelector("input");
    if (!(input instanceof dom.window.HTMLInputElement)) {
      throw new Error("expected input fixture");
    }
    input.value = "éé";

    try {
      buildBrowserWorkspaceDocumentSnapshotText(dom.window.document);
      throw new Error("expected snapshot rejection");
    } catch (error) {
      expectContentTooLarge(error, "document_snapshot");
    }
  });
});
