import assert from "node:assert/strict";
import test from "node:test";
import { gmailSourceLink } from "./bill-source-link.mjs";

const link = "https://mail.google.com/mail/u/person%40example.org/#all/thread1";
test("source links bind Gmail origin, explicit account and exact thread", () => {
  assert.equal(gmailSourceLink(link, "thread1", "person@example.org"), link);
  assert.equal(gmailSourceLink(link, "thread1"), link);
  assert.equal(gmailSourceLink(link, "other", "person@example.org"), null);
  assert.equal(gmailSourceLink(link, "thread1", "other@example.org"), null);
  for (const bad of [
    link.replace("https:", "http:"),
    link.replace("mail.google.com", "MAIL.google.com"),
    link.replace("mail.google.com", "mail.google.com:443"),
    link.replace("mail.google.com", "mail.google.com.evil.example"),
    link.replace("mail.google.com", "person@mail.google.com"),
    link.replace("/person%40example.org/", "/0/"),
    link.replace("#all/", "?redirect=https://evil.example#all/"),
    link.replace("#all/", "?authuser=other@example.org#all/"),
    link.replace("#all/", "#search/"),
    link.replace("/mail/u/", "/mail/../u/"),
    "javascript:alert(1)",
  ])
    assert.equal(
      gmailSourceLink(bad, "thread1", "person@example.org"),
      null,
      bad,
    );
});
