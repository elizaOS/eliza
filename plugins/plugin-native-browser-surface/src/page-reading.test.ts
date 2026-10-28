/** Page reading: credential refusal, the capability probe and the page-question excerpt rule. */
import { describe, expect, it } from "vitest";

import {
  createReadingSupport,
  ISOLATED_WORLD_UNAVAILABLE,
  pageQuestionExcerpt,
  SENSITIVE_PAGE,
  sensitiveReadingDocument,
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
});
