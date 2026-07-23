/**
 * Verifies that the cloud settings fixture can bundle wagmi's complete
 * connector graph without installing optional wallet SDKs it never executes.
 */

import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  optionalWalletPeerStubPlugin,
  optionalWalletPeers,
} from "../__e2e__/optional-wallet-peer-stub";

describe("optional wallet peer fixture stubs", () => {
  it("resolves every absent wallet connector peer", async () => {
    const result = await build({
      stdin: {
        contents: optionalWalletPeers
          .map((peer) => `import "${peer}";`)
          .join("\n"),
        resolveDir: process.cwd(),
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      plugins: [optionalWalletPeerStubPlugin],
      write: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.outputFiles).toHaveLength(1);
  });
});
