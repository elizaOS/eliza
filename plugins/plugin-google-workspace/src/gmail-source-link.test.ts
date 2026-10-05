import { describe, expect, it } from "vitest";
import { gmailThreadSourceLink } from "./gmail-source-link";

describe("Gmail account source link", () => {
  it("uses the normalized resolved account including plus-addressing", () => {
    expect(gmailThreadSourceLink("thread_1", " Person+Bills@Example.org ")).toBe(
      "https://mail.google.com/mail/u/person%2Bbills%40example.org/#all/thread_1"
    );
  });
  it("omits a link when account identity is unavailable", () => {
    for (const account of [null, "", "0", "not an email", "person@example.org\nother"])
      expect(gmailThreadSourceLink("thread", account)).toBeNull();
  });
  it("rejects a thread that could change the URL meaning", () => {
    for (const thread of ["", "../other", "thread?x=1", "thread#other", "a".repeat(257)])
      expect(gmailThreadSourceLink(thread, "person@example.org")).toBeNull();
  });
});
