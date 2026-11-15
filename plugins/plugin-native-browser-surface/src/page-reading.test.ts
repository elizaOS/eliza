/** Page reading: credential refusal, the capability probe and the page-question excerpt rule. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createReadingSupport,
  ISOLATED_WORLD_UNAVAILABLE,
  pageQuestionExcerpt,
  pageQuestionReading,
  readingWords,
  SENSITIVE_PAGE,
  sensitiveReadingDocument,
  sensitiveReadingPattern,
  sensitiveReadingText,
  sensitiveReadingUrl,
} from "./page-reading";

describe("credential refusal", () => {
  it("refuses credential prose and unlabelled codes, and keeps ordinary prose and years", () => {
    for (const text of [
      "API key: SYNTHETIC",
      "refresh_token: x",
      "Ｐａｓｓｗｏｒｄ: synthetic",
      "pass\u200Bword: synthetic",
      "Verification code 001122",
      "001122",
      "Sign in to continue",
    ])
      expect(sensitiveReadingText(text), text).toBe(true);
    expect(sensitiveReadingText("A garden journal from 2027.")).toBe(false);
  });

  const prose = [
    "signing the bill",
    "designing a kitchen",
    "assigning blame",
    "the best blog in town",
    "Vaulted ceilings",
    "catalog index",
  ];
  const credentialWords = [
    "Sign in",
    "log-in",
    "Bitwarden vault",
    "Your Vaults",
  ];
  const element = (
    tagName: string,
    attributes: Record<string, string>,
    children: Node[] = [],
  ) =>
    ({
      nodeType: 1,
      tagName,
      getAttribute: (name: string) => attributes[name] ?? null,
      childNodes: children,
    }) as unknown as Node;

  it("reads sign-in, log-in and vault only as whole words", () => {
    for (const text of prose)
      expect(sensitiveReadingText(text), text).toBe(false);
    for (const text of credentialWords)
      expect(sensitiveReadingText(text), text).toBe(true);
    const attributes = (value: string) =>
      sensitiveReadingDocument(
        element("ARTICLE", {}, [element("DIV", { id: value, class: value })]),
      );
    expect(attributes("dialog-inner")).toBe(false);
    expect(attributes("catalog-index")).toBe(false);
    for (const value of [
      "signInButton",
      "login_form",
      "btn-login2",
      "SSOLogin",
      "vaultList",
    ])
      expect(attributes(value), value).toBe(true);
  });

  it("matches the Android extraction script", () => {
    const script = readFileSync(
      new URL(
        "../android/src/main/java/ai/eliza/plugins/browsersurface/BrowserPageReading.java",
        import.meta.url,
      ),
      "utf8",
    ).replace(/\\\\/g, "\\");
    const line = (name: string) =>
      script.match(new RegExp(`^\\s*const ${name}=(.*);$`, "m"))?.[1] ?? "";
    expect(line("sensitive")).toBe(sensitiveReadingPattern.toString());
    const flagged = new Function(
      `const sensitive=${line("sensitive")};const words=${line("words")};return ${line("flagged")};`,
    )() as (value: string) => boolean;
    for (const value of [...prose, "dialog-inner", "SSOLogin", "signInButton"])
      expect(readingWords(value)).toBe(
        new Function(`return ${line("words")}`)()(value),
      );
    for (const value of prose) expect(flagged(value), value).toBe(false);
    for (const value of [...credentialWords, "signInButton", "login_form"])
      expect(flagged(value), value).toBe(true);
  });

  it("refuses password services, credential routes and unparseable addresses", () => {
    for (const url of [
      "https://pass.proton.me/",
      "https://vault.bitwarden.com/x",
      "https://example.com/%70assword",
      "https://example.com/#/vault",
      "https://example.com/article?API+KEY=x",
      "https://example.com/a?%61pi%5fkey=x",
      "https://user@example.com/",
      "ftp://example.com/",
      "not a url",
    ])
      expect(sensitiveReadingUrl(url), url).toBe(true);
    expect(sensitiveReadingUrl("https://example.com/garden/journal")).toBe(
      false,
    );
  });

  it("scans attributes and text of the whole document, skipping scripts", () => {
    const element = (
      tagName: string,
      attributes: Record<string, string>,
      children: Node[] = [],
    ) =>
      ({
        nodeType: 1,
        tagName,
        getAttribute: (name: string) => attributes[name] ?? null,
        childNodes: children,
      }) as unknown as Node;
    const text = (value: string) =>
      ({ nodeType: 3, nodeValue: value, childNodes: [] }) as unknown as Node;
    const article = (children: Node[]) => element("ARTICLE", {}, children);
    expect(sensitiveReadingDocument(article([text("Garden journal")]))).toBe(
      false,
    );
    expect(
      sensitiveReadingDocument(
        article([element("INPUT", { type: "password" }), text("Garden")]),
      ),
    ).toBe(true);
    expect(
      sensitiveReadingDocument(
        article([element("SCRIPT", {}, [text("password")]), text("Garden")]),
      ),
    ).toBe(false);
  });

  it("ignores sign-in chrome and long navigation, but not credential inputs or codes in the article", () => {
    const element = (
      tagName: string,
      attributes: Record<string, string>,
      children: Node[] = [],
    ) =>
      ({
        nodeType: 1,
        tagName,
        getAttribute: (name: string) => attributes[name] ?? null,
        childNodes: children,
      }) as unknown as Node;
    const text = (value: string) =>
      ({ nodeType: 3, nodeValue: value, childNodes: [] }) as unknown as Node;
    const page = (main: Node[], footer: Node[] = []) =>
      element("HTML", {}, [
        element("BODY", {}, [
          element("HEADER", { class: "site-header" }, [
            element("A", { href: "/login", class: "login-button" }, [
              text("Sign in"),
            ]),
          ]),
          element("NAV", {}, [text("Section ".repeat(10000))]),
          element("MAIN", {}, main),
          element("FOOTER", {}, footer),
        ]),
      ]);
    expect(sensitiveReadingDocument(page([text("Garden journal 2027")]))).toBe(
      false,
    );
    expect(
      sensitiveReadingDocument(
        page(
          [text("Garden journal")],
          [element("INPUT", { type: "password", name: "pw" })],
        ),
      ),
    ).toBe(true);
    expect(
      sensitiveReadingDocument(
        page(
          [text("Garden journal")],
          [element("INPUT", { autocomplete: "one-time-code" })],
        ),
      ),
    ).toBe(true);
    // pageSourceText passes a parsed fragment: its footer inputs still refuse.
    const fragment = (children: Node[]) =>
      ({ nodeType: 11, childNodes: children }) as unknown as Node;
    expect(
      sensitiveReadingDocument(
        fragment([
          element("MAIN", {}, [text("Garden journal")]),
          element("FOOTER", {}, [element("INPUT", { type: "password" })]),
        ]),
      ),
    ).toBe(true);
    expect(
      sensitiveReadingDocument(
        fragment([element("MAIN", {}, [text("Garden journal")])]),
      ),
    ).toBe(false);
    expect(
      sensitiveReadingDocument(page([text("Your verification code is ready")])),
    ).toBe(true);
    expect(sensitiveReadingDocument(page([text("Code 48213907")]))).toBe(true);
  });
});

describe("reading support probe", () => {
  it("believes only an explicit boolean and asks again after a failure", async () => {
    let answers: unknown[] = [new Error("bridge closed"), { available: false }];
    let asked = 0;
    let changed = 0;
    const support = createReadingSupport(
      async () => {
        const answer = answers[Math.min(asked++, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer;
      },
      () => changed++,
    );
    expect(await Promise.all([support.check(), support.check()])).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(await support.check()).toBe("unavailable");
    expect(await support.check()).toBe("unavailable");
    expect({ asked, changed }).toEqual({ asked: 2, changed: 1 });
    answers = [{ available: "false" }];
    asked = 0;
    const malformed = createReadingSupport(
      async () => answers[Math.min(asked++, answers.length - 1)],
    );
    expect(await malformed.check()).toBe("unknown");
    expect(malformed.state).toBe("unknown");
  });
});

describe("page question excerpt", () => {
  const reject = (code: string | undefined, message = "refused") =>
    pageQuestionExcerpt(async () => {
      throw Object.assign(new Error(message), code ? { code } : {});
    });

  it("opens an empty review for pasted text when the isolated world is unavailable", async () => {
    expect(await reject(ISOLATED_WORLD_UNAVAILABLE)).toBe("");
    expect(
      await reject(
        undefined,
        "Isolated page reading is unavailable. Update Android System WebView, then reload this page.",
      ),
    ).toBe("");
  });

  it("never opens a review for a sensitive page or excerpt", async () => {
    await expect(reject(SENSITIVE_PAGE)).rejects.toMatchObject({
      code: SENSITIVE_PAGE,
    });
    await expect(
      pageQuestionExcerpt(async () => ({ text: "Recovery code 12345678" })),
    ).rejects.toMatchObject({ code: SENSITIVE_PAGE });
    await expect(reject("reading-not-ready")).rejects.toThrow("refused");
  });

  it("releases a bounded, non-empty excerpt only", async () => {
    expect(
      await pageQuestionExcerpt(async () => ({ text: "Garden journal" })),
    ).toBe("Garden journal");
    expect(await pageQuestionExcerpt(async () => ({ text: "   " }))).toBe("");
    expect(
      await pageQuestionExcerpt(async () => ({ text: "a".repeat(5001) })),
    ).toBe("");
    expect(await pageQuestionExcerpt(async () => null)).toBe("");
  });

  it("keeps whether the page was cut to fit the excerpt", async () => {
    expect(
      await pageQuestionReading(async () => ({
        text: "Garden journal",
        truncated: true,
      })),
    ).toEqual({ text: "Garden journal", truncated: true });
    expect(
      await pageQuestionReading(async () => ({ text: "Garden journal" })),
    ).toEqual({ text: "Garden journal", truncated: false });
    expect(
      await pageQuestionReading(async () => ({ text: "  ", truncated: true })),
    ).toEqual({ text: "", truncated: false });
    expect(
      await pageQuestionReading(async () => {
        throw Object.assign(new Error("x"), {
          code: ISOLATED_WORLD_UNAVAILABLE,
        });
      }),
    ).toEqual({ text: "", truncated: false });
  });
});
