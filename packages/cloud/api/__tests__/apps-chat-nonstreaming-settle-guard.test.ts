/** Verifies app chat non-streaming uses canonical detached accounting. */

import { expect, test } from "bun:test";

test("app chat has no route-local synchronous credit settlement", async () => {
  const [wrapper, canonical] = await Promise.all([
    Bun.file(new URL("../v1/apps/[id]/chat/route.ts", import.meta.url)).text(),
    Bun.file(
      new URL("../v1/chat/completions/route.ts", import.meta.url),
    ).text(),
  ]);

  expect(wrapper).not.toContain("deductCredits");
  expect(wrapper).not.toContain("reconcileCredits");
  expect(canonical).toContain("requiredAppId");
  expect(canonical).toContain("admissionSnapshot");
});
