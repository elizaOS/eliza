import assert from "node:assert/strict";
import test from "node:test";
import { detectDomainLookalike } from "./domain-lookalike.mjs";

const references = Object.freeze([
  "google.com",
  "bankofamerica.com",
  "chase.com",
  "capitalone.com",
  "paypal.com",
]);
test("flags swaps, Unicode, changed suffixes, private suffixes and embedded official hosts", () => {
  for (const host of [
    "goolge.com",
    "gоogle.com",
    "google.net",
    "bankofamerіca.com",
    "login.chase.com.evil.example",
    "chase.com.attacker.co.uk",
    "chase.github.io",
    "capitaloen.com",
    "paypa1.com",
  ])
    assert.equal(
      detectDomainLookalike("https://" + host, references)?.status,
      "lookalike",
      host,
    );
});
test("does not treat unrelated names or reference subdomains as suspicious", () => {
  for (const host of [
    "mail.google.com",
    "secure.chase.com",
    "chase.com.",
    "example.co.uk",
    "bücher.de",
    "mybusiness.github.io",
    "google-example.org",
  ])
    assert.equal(
      detectDomainLookalike("https://" + host, references),
      null,
      host,
    );
});
test("reference domains are host-selected and empty selection makes no brand claim", () => {
  assert.equal(detectDomainLookalike("https://goolge.com", []), null);
  assert.equal(
    detectDomainLookalike("https://goolge.com", ["example.com"]),
    null,
  );
  assert.deepEqual(detectDomainLookalike("https://goolge.com", references), {
    status: "lookalike",
    suggested: "https://google.com/",
    reason: "similar-domain",
  });
  assert.throws(
    () => detectDomainLookalike("not a URL", references),
    TypeError,
  );
});
