import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packagedRuntimeFiles } from "./apk-runtime-provenance.mjs";

test("records packaged bytes after native stripping and asset renaming", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apk-provenance-"));
  try {
    fs.mkdirSync(path.join(root, "assets/agent"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib/x86_64"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets/agent/agent-bundle.js"), "agent");
    fs.writeFileSync(
      path.join(root, "assets/agent/vector.tar"),
      "expanded asset",
    );
    fs.writeFileSync(
      path.join(root, "lib/x86_64/runtime.so"),
      "stripped native",
    );
    const apk = path.join(root, "runtime.apk");
    execFileSync("zip", ["-qr", apk, "assets", "lib"], { cwd: root });
    const files = packagedRuntimeFiles(apk);
    expect(
      files.find((file) => file.path === "lib/x86_64/runtime.so")?.sha256,
    ).toBe(createHash("sha256").update("stripped native").digest("hex"));
    expect(
      files.find((file) => file.path === "assets/agent/vector.tar")?.size_bytes,
    ).toBe(Buffer.byteLength("expanded asset"));
    fs.writeFileSync(
      path.join(root, "lib/x86_64/runtime.so"),
      "changed native",
    );
    execFileSync("zip", ["-q", apk, "lib/x86_64/runtime.so"], { cwd: root });
    expect(packagedRuntimeFiles(apk)).not.toEqual(files);
    execFileSync("zip", ["-qd", apk, "assets/agent/agent-bundle.js"]);
    expect(() => packagedRuntimeFiles(apk)).toThrow(
      "missing its packaged agent bundle",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
