import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileThreatRules,
  exceptionRule,
  installThreatRules,
  MAX_DOMAINS,
  RULE_BASE,
} from "../protection/policy.mjs";

const id = "a".repeat(32);
test("native policy batches all domains without dropping threats and includes frame/subresource blocking", () => {
  const domains = Array.from({ length: 5001 }, (_, i) => `threat${i}.example`);
  const rules = compileThreatRules([...domains, domains[0]], id);
  assert.equal(rules.length, 6);
  assert.equal(
    rules
      .filter((r) => r.action.type === "block")
      .flatMap((r) => r.condition.requestDomains).length,
    5001,
  );
  assert.ok(
    rules
      .filter((r) => r.action.type === "redirect")
      .every((r) => r.condition.resourceTypes.includes("main_frame")),
  );
  for (const value of [
    "https://bad.example/path",
    "com",
    "bad..example",
    "bad.example/path",
  ])
    assert.throws(() => compileThreatRules([value], id));
  assert.throws(() => compileThreatRules([], id));
  assert.ok(MAX_DOMAINS / 2000 < 1000);
});
test("atomic replacement preserves unrelated rules and does not clear old rules on install failure", async () => {
  let calls = 0;
  await assert.rejects(
    installThreatRules(
      {
        getDynamicRules: async () => [{ id: 2 }, { id: RULE_BASE }],
        updateDynamicRules: async (update) => {
          calls++;
          assert.deepEqual(update.removeRuleIds, [RULE_BASE]);
          assert.equal(update.addRules.length, 2);
          throw Error("quota");
        },
      },
      ["bad.example"],
      id,
    ),
  );
  assert.equal(calls, 1);
});
test("exceptions are exact-address, case-sensitive, main-frame and tab-bound", () => {
  const rule = exceptionRule("https://bad.example/Case?q=a.b#fragment", 23);
  assert.deepEqual(rule.condition.tabIds, [23]);
  assert.deepEqual(rule.condition.requestMethods, ["get"]);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
  const match = new RegExp(rule.condition.regexFilter);
  assert.ok(match.test("https://bad.example/Case?q=a.b"));
  assert.ok(!match.test("https://bad.example/Case?q=axb"));
  assert.ok(!match.test("https://bad.example/case?q=a.b"));
  assert.ok(!match.test("https://other.example/Case?q=a.b"));
  for (const value of [
    "javascript:alert(1)",
    "https://user:pass@bad.example",
    `https://bad.example/${"a".repeat(900)}`,
  ])
    assert.throws(() => exceptionRule(value, 23));
});

test("host warning page is configurable without accepting a path or remote authority", () => {
  const rules = compileThreatRules(["blocked.example"], "a".repeat(32), {
    warningPage: "custom-warning.html",
  });
  assert.match(
    rules[1].action.redirect.regexSubstitution,
    /\/custom-warning\.html#/,
  );
  for (const warningPage of [
    "../warning.html",
    "https://evil.test/x",
    "warning.html?x",
  ])
    assert.throws(
      () =>
        compileThreatRules(["blocked.example"], "a".repeat(32), {
          warningPage,
        }),
      /Invalid warning/,
    );
});
