/** Verifies the real Linux child-process reader's encoded capacity with an isolated executable/credential fixture and real SQLite; never invokes the installed secret-tool. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNodePlatformSecureStore } from "./platform-secure-store-node";
import { RendererSecureStoreLedger } from "./renderer-secure-store-ledger";
import { RendererSecureStoreTransactions } from "./renderer-secure-store-transactions";

it.skipIf(process.platform === "win32")(
  "round-trips the largest escaped renderer transaction through the Linux process reader",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-linux-reader-test-"));
    const previousPath = process.env.PATH;
    let writes = 0;
    try {
      // The fixture's argv follows secret-tool lookup, but its only data source is
      // this test directory. No real Secret Service, D-Bus or credential is used.
      writeFileSync(
        join(directory, "secret-tool"),
        `#!${process.execPath}\nconst fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");const a=process.argv.slice(2),account=a[a.indexOf("account")+1],f=path.join(__dirname,crypto.createHash("sha256").update(account).digest("hex"));if(fs.existsSync(f))process.stdout.write(fs.readFileSync(f));else process.exitCode=1;\n`,
        { mode: 0o700 },
      );
      process.env.PATH = `${directory}:${previousPath}`;
      const native = createNodePlatformSecureStore({
        platform: "linux",
        secretToolAvailable: async () => true,
        secretServiceReachable: () => true,
        storeSecretTool: async (args, line) => {
          writes++;
          const account = args[args.indexOf("account") + 1];
          if (!account) throw new Error("Fixture account missing");
          writeFileSync(
            join(directory, createHash("sha256").update(account).digest("hex")),
            line,
            { mode: 0o600 },
          );
        },
      });
      const vault = "linux-encoded-fixture",
        slot = "runtime.agent_profiles";
      const ledger = new RendererSecureStoreLedger(directory, native);
      await ledger.migrateLegacy(vault);
      const protocol = new RendererSecureStoreTransactions(
        ledger.store,
        ledger,
      );
      const value = "\u0000".repeat(256 * 1024);
      const expected = await protocol.write(vault, slot, value);
      const receipt = await protocol.prepare(
        vault,
        slot,
        expected,
        value,
        randomUUID(),
      );
      await protocol.commit(vault, slot, receipt);
      await protocol.seal(vault, slot, receipt);
      expect((await protocol.read(vault, slot)).value === value).toBe(true);
      const before = writes;
      await expect(
        protocol.write(vault, slot, `${value}x`),
      ).rejects.toMatchObject({ code: "NATIVE_STORE_INVALID_INPUT" });
      expect(writes).toBe(before);
      expect((await protocol.read(vault, slot)).value === value).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
