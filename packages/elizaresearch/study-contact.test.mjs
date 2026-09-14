/**
 * Exercises the study-contact Worker's real request contract: routing, body
 * limits, validation, honeypot behavior, missing-secret refusal, and the
 * Resend delivery payload. The Worker module is imported directly and the
 * provider call is intercepted by stubbing global fetch — no network access.
 */

import { afterEach, describe, expect, it } from "bun:test";
import worker, {
  FIELD_LIMITS,
  MAX_BODY_BYTES,
  looksLikeEmail,
  renderEmail,
  validateSubmission,
} from "./study-contact.mjs";

const ORIGIN = "https://elizaresearch.ai";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function contactRequest(body, init = {}) {
  return new Request(`${ORIGIN}/api/study-contact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

const VALID = {
  name: "Dorothy Simmons",
  contact: "dorothy@example.com",
  role: "A senior",
  message: "I got your flyer and wanted to check this is real.",
  website: "",
};

const SECRETS = { RESEND_API_KEY: "re_test_key", CONTACT_TO: "inbox@example.com" };

describe("validateSubmission", () => {
  it("normalizes a complete submission", () => {
    const result = validateSubmission({ ...VALID, name: "  Dorothy Simmons  " });
    expect(result.ok).toBe(true);
    expect(result.submission.name).toBe("Dorothy Simmons");
    expect(result.honeypot).toBe("");
  });

  it("rejects missing required fields with a visitor-facing message", () => {
    const result = validateSubmission({ ...VALID, message: "   " });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("a message");
  });

  it("rejects oversized fields instead of truncating them", () => {
    const result = validateSubmission({ ...VALID, message: "x".repeat(FIELD_LIMITS.message + 1) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too long");
  });

  it("coerces an unknown role to the catch-all instead of trusting client text", () => {
    const result = validateSubmission({ ...VALID, role: "<script>alert(1)</script>" });
    expect(result.ok).toBe(true);
    expect(result.submission.role).toBe("Something else");
  });

  it("rejects non-object payloads", () => {
    expect(validateSubmission("hello").ok).toBe(false);
    expect(validateSubmission(null).ok).toBe(false);
  });
});

describe("renderEmail", () => {
  it("carries every field the recipient needs to reply", () => {
    const { subject, text } = renderEmail(validateSubmission(VALID).submission);
    expect(subject).toContain("Dorothy Simmons");
    expect(subject).toContain("A senior");
    expect(text).toContain("dorothy@example.com");
    expect(text).toContain(VALID.message);
  });
});

describe("looksLikeEmail", () => {
  it("accepts addresses and rejects phone numbers", () => {
    expect(looksLikeEmail("dorothy@example.com")).toBe(true);
    expect(looksLikeEmail("(347) 391-7236")).toBe(false);
  });
});

describe("worker.fetch routing", () => {
  it("falls through to the assets binding for page requests", async () => {
    let served = null;
    const env = { ASSETS: { fetch: (request) => { served = request.url; return new Response("page"); } } };
    const response = await worker.fetch(new Request(`${ORIGIN}/study/`), env);
    expect(await response.text()).toBe("page");
    expect(served).toBe(`${ORIGIN}/study/`);
  });

  it("refuses non-POST methods on the contact endpoint", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/study-contact`), {});
    expect(response.status).toBe(405);
  });

  it("rejects unparsable bodies", async () => {
    const response = await worker.fetch(contactRequest("{not json"), SECRETS);
    expect(response.status).toBe(400);
    expect((await response.json()).ok).toBe(false);
  });

  it("rejects oversized bodies before parsing", async () => {
    const response = await worker.fetch(
      contactRequest(JSON.stringify({ message: "x".repeat(MAX_BODY_BYTES) })),
      SECRETS,
    );
    expect(response.status).toBe(413);
  });

  it("returns a fake success for honeypot submissions without delivering", async () => {
    let delivered = false;
    globalThis.fetch = async () => { delivered = true; return new Response("{}"); };
    const response = await worker.fetch(contactRequest({ ...VALID, website: "spam.example" }), SECRETS);
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(delivered).toBe(false);
  });

  it("refuses with 503 when delivery secrets are not configured", async () => {
    const response = await worker.fetch(contactRequest(VALID), {});
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain("(347) 391-7236");
  });

  it("delivers a valid submission through Resend with reply-to set", async () => {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    };
    const response = await worker.fetch(contactRequest(VALID), SECRETS);
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
    expect(captured.url).toBe("https://api.resend.com/emails");
    expect(captured.auth).toBe("Bearer re_test_key");
    expect(captured.body.to).toEqual(["inbox@example.com"]);
    expect(captured.body.reply_to).toBe("dorothy@example.com");
    expect(captured.body.text).toContain(VALID.message);
  });

  it("translates provider failure into a visitor-facing 502", async () => {
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    const response = await worker.fetch(contactRequest(VALID), SECRETS);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("(347) 391-7236");
  });

  it("omits reply-to when the visitor left a phone number", async () => {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    };
    await worker.fetch(contactRequest({ ...VALID, contact: "(347) 391-7236" }), SECRETS);
    expect(captured.reply_to).toBeUndefined();
    expect(captured.text).toContain("(347) 391-7236");
  });
});
