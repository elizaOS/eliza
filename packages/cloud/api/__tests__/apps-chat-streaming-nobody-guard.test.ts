/** Verifies app chat streaming inherits the canonical durable settlement path. */

import { expect, test } from "bun:test";

test("app chat delegates streaming to canonical app admission", async () => {
  const [wrapper, canonical] = await Promise.all([
    Bun.file(new URL("../v1/apps/[id]/chat/route.ts", import.meta.url)).text(),
    Bun.file(
      new URL("../v1/chat/completions/route.ts", import.meta.url),
    ).text(),
  ]);

  expect(wrapper).toContain("handleChatCompletionsPOST");
  expect(wrapper).toContain("requiredAppId: appId");
  expect(canonical).toContain("admitAppInferenceCacheOnly");
  expect(canonical).toContain("settleOffResponsePath");
  expect(wrapper).not.toContain("appCreditsService.reconcileCredits");
});
