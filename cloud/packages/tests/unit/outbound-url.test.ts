import { describe, expect, test } from "bun:test";

const moduleUrl = new URL("../../lib/security/outbound-url.ts", import.meta.url).href;

function runIsolatedSnippet(source: string) {
  return Bun.spawnSync({
    cmd: ["bun", "-e", source],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("outbound URL safety", () => {
  test("rejects localhost and link-local destinations", () => {
    const result = runIsolatedSnippet(`
      const mod = await import(${JSON.stringify(`${moduleUrl}?case=localhost`)});
      const { assertSafeOutboundUrl } = mod;
      try {
        await assertSafeOutboundUrl("http://127.0.0.1:3000/mcp");
        console.log("unexpected-success");
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    `);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toMatch(/private|reserved|localhost/i);

    const linkLocal = runIsolatedSnippet(`
      const mod = await import(${JSON.stringify(`${moduleUrl}?case=linklocal`)});
      const { assertSafeOutboundUrl } = mod;
      try {
        await assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data");
        console.log("unexpected-success");
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    `);

    expect(linkLocal.exitCode).toBe(1);
    expect(new TextDecoder().decode(linkLocal.stderr)).toMatch(/private|reserved/i);
  });

  test("classifies private IPv4 destinations as forbidden", () => {
    const result = runIsolatedSnippet(`
      const mod = await import(${JSON.stringify(`${moduleUrl}?case=forbidden-ip`)});
      const { isForbiddenIpAddress } = mod;
      console.log(JSON.stringify({
        private10: isForbiddenIpAddress("10.0.0.7"),
        cgnat: isForbiddenIpAddress("100.64.0.10"),
        publicIp: isForbiddenIpAddress("93.184.216.34"),
      }));
    `);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      private10: true,
      cgnat: true,
      publicIp: false,
    });
  });

  test("accepts public https endpoints", () => {
    const result = runIsolatedSnippet(`
      const mod = await import(${JSON.stringify(`${moduleUrl}?case=public`)});
      const { assertSafeOutboundUrl } = mod;
      const url = await assertSafeOutboundUrl("https://93.184.216.34/mcp");
      console.log(url.toString());
    `);

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe("https://93.184.216.34/mcp");
  });

  test("rejects URLs that embed credentials", () => {
    const result = runIsolatedSnippet(`
      const mod = await import(${JSON.stringify(`${moduleUrl}?case=credentials`)});
      const { assertSafeOutboundUrl } = mod;
      try {
        await assertSafeOutboundUrl("https://user:pass@example.com/mcp");
        console.log("unexpected-success");
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    `);

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toMatch(/credentials/i);
  });
});
