import assert from "node:assert/strict";
import test from "node:test";
import { createResearchServer } from "./research-server.mjs";

test("asset failure produces a complete coarse response before writing success headers", async () => {
  const server = createResearchServer({
    store: {},
    operators: [
      { name: "fixture", role: "admin", tokenSha256: "a".repeat(64) },
    ],
    readAsset: () => {
      throw new Error("private path must not escape");
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Pilot request could not be completed",
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
