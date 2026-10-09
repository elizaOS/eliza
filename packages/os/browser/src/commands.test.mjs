import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_CONTROL, pageCommand } from "./commands.mjs";

test("the in-page click guard uses the exported commit vocabulary", () => {
  // pageCommand runs as source text in the page, so it carries its own copy.
  assert.ok(pageCommand.toString().includes(COMMIT_CONTROL.source));
  for (const label of [
    "Confirm payment",
    "Make a payment",
    "Pay",
    "Schedule payment",
    "Continue",
    "Sign in",
    "Log in",
    "Place your order",
    "Check out",
    "Authorize",
    "I agree",
    "Save changes",
  ])
    assert.equal(COMMIT_CONTROL.test(label), true, label);
  for (const label of [
    "Use existing method",
    "Use saved Visa",
    "Billing history",
    "Account details",
    "Paperless billing",
  ])
    assert.equal(COMMIT_CONTROL.test(label), false, label);
});
