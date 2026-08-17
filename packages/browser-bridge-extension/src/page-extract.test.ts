/**
 * Unit tests for capturePageContext over a jsdom DOM (test-dom-setup): field
 * extraction, visibility filtering, and length caps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-dom-setup";
import { capturePageContext } from "./page-extract";

describe("capturePageContext", () => {
  beforeEach(() => {
    document.title = "Unit page";
    document.body.innerHTML = "";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures visible page context while excluding hidden/password fields", () => {
    document.body.innerHTML = `
      <main>
        <h1>Account Settings</h1>
        <p>Visible text   with spacing.</p>
        <p style="display: none">Hidden text should not leak.</p>
        <a href="/next">Next page</a>
        <form action="/save">
          <input name="email" />
          <input type="password" name="password" />
          <input type="hidden" name="csrf" />
          <textarea aria-label="Notes"></textarea>
        </form>
      </main>
    `;

    const snapshot = capturePageContext();

    expect(snapshot).toMatchObject({
      url: "https://unit-test.local/",
      title: "Unit page",
      headings: ["Account Settings"],
      links: [{ text: "Next page", href: "https://unit-test.local/next" }],
      forms: [
        {
          action: "https://unit-test.local/save",
          fields: ["email", "Notes"],
        },
      ],
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(snapshot.mainText).toContain("Visible text with spacing.");
    expect(snapshot.mainText).not.toContain("Hidden text");
  });

  it("normalizes script-like text as text without executing or exposing hidden fields", () => {
    document.body.innerHTML = `
      <h2>Search</h2>
      <p>&lt;script&gt;alert(1)&lt;/script&gt;</p>
      <form>
        <input id="visible-query" />
        <input type="hidden" id="internal-token" />
      </form>
    `;

    const snapshot = capturePageContext();

    expect(snapshot.mainText).toContain("<script>alert(1)</script>");
    expect(snapshot.forms[0]?.fields).toEqual(["visible-query"]);
  });

  it("does not leak text or field names hidden by an ancestor", () => {
    document.body.innerHTML = `
      <section>
        <p>Visible account copy.</p>
        <div style="display: none">
          <p>Nested hidden recovery code.</p>
          <form action="/hidden">
            <input name="hidden-email" />
          </form>
        </div>
        <form action="/visible">
          <div style="visibility: hidden">
            <input name="shadow-token" />
          </div>
          <input name="visible-email" />
        </form>
      </section>
    `;

    const snapshot = capturePageContext();

    expect(snapshot.mainText).toContain("Visible account copy.");
    expect(snapshot.mainText).not.toContain("Nested hidden recovery code");
    expect(snapshot.forms).toContainEqual({
      action: "https://unit-test.local/visible",
      fields: ["visible-email"],
    });
    expect(JSON.stringify(snapshot.forms)).not.toContain("hidden-email");
    expect(JSON.stringify(snapshot.forms)).not.toContain("shadow-token");
  });

  it("bounds large text, heading, link, and form collections", () => {
    document.body.innerHTML = [
      ...Array.from({ length: 20 }, (_, index) => `<h1>Heading ${index}</h1>`),
      ...Array.from(
        { length: 50 },
        (_, index) => `<a href="/${index}">Link ${index}</a>`,
      ),
      ...Array.from(
        { length: 15 },
        (_, index) =>
          `<form action="/${index}"><input name="field-${index}" /></form>`,
      ),
      `<p>${"x".repeat(13_000)}</p>`,
    ].join("");

    const snapshot = capturePageContext();

    expect(snapshot.headings).toHaveLength(12);
    expect(snapshot.links).toHaveLength(40);
    expect(snapshot.forms).toHaveLength(10);
    expect(snapshot.mainText?.length).toBeLessThanOrEqual(12_000);
  });
});
