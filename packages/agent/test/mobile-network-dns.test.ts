import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
it("mobile host DNS configuration reaches the real resolver without breaking local gateway HTTP", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "eliza-mobile-network-"));
  try {
    const output = path.join(temporary, "network.mjs");
    const config = path.join(temporary, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          baseUrl: here,
          paths: { "@elizaos/core": ["./fixtures/mobile-network-core.ts"] },
        },
      }),
    );
    execFileSync(
      "bun",
      [
        "build",
        path.join(here, "fixtures/mobile-network-dns-child.ts"),
        "--target=node",
        "--outfile",
        output,
        "--tsconfig-override",
        config,
      ],
      { stdio: "pipe" },
    );
    const result = execFileSync("bun", [output], {
      encoding: "utf8",
      env: {
        ...process.env,
        ELIZA_PLATFORM: "android",
        ELIZA_MOBILE_DNS_SERVERS: "10.0.2.3,2001:db8::53",
      },
      timeout: 15000,
    });
    expect(result).toContain(
      "native DNS configuration and loopback transport passed",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 30000);
