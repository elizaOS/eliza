/** Verifies Electrobun native callback string hardening against the installed SDK and a real Bun FFI callback. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hardenElectrobunCallbackStrings } from "./electrobun-ffi-callback-strings.ts";

const NATIVE = path.join("api", "bun", "proc", "native.ts");
const CALLBACK_CONVERSION =
  /new CString\((filePath|urlPtr|acceleratorPtr|_eventName|_detail|msg|action)\b/;
function fixture(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electrobun-cstring-"));
  for (const dist of ["dist", "dist-macos-arm64"]) {
    const dir = path.join(root, dist, "api", "bun", "proc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "native.ts"), source);
  }
  return root;
}

function installedSource(): string {
  const shell = fileURLToPath(
    new URL("../../platforms/electrobun/", import.meta.url),
  );
  const candidates = [
    path.join(shell, "node_modules", "electrobun", "dist", NATIVE),
    path.join(
      shell,
      "..",
      "..",
      "..",
      "..",
      "node_modules",
      "electrobun",
      "dist",
      NATIVE,
    ),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(found, "installed Electrobun native.ts was not found");
  return fs.readFileSync(found, "utf8");
}

test("patches every installed callback conversion in shared and platform cores idempotently", () => {
  const installed = installedSource();
  // A previous desktop build hardens the installed copy in place.
  const alreadyHardened = installed.includes("function elizaCallbackString(");
  const root = fixture(installed);
  try {
    assert.equal(
      hardenElectrobunCallbackStrings(root).length,
      alreadyHardened ? 0 : 2,
    );
    assert.equal(hardenElectrobunCallbackStrings(root).length, 0);
    for (const dist of ["dist", "dist-macos-arm64"]) {
      const source = fs.readFileSync(path.join(root, dist, NATIVE), "utf8");
      assert.doesNotMatch(source, CALLBACK_CONVERSION);
      assert.match(source, /elizaCallbackString\(action\)/);
      assert.match(source, /elizaCallbackString\(acceleratorPtr\)/);
      assert.match(source, /function elizaCallbackString\(value: unknown\)/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the upstream callback shape changes", () => {
  const root = fixture("const handler = (action) => String(action);\n");
  try {
    assert.throws(
      () => hardenElectrobunCallbackStrings(root),
      /cannot find callback cstring conversions/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Bun cstring callback argument converts without throwing", () => {
  const root = fixture(
    `import { CFunction, CString, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";
const seen: string[] = [];
const trayItemHandler = new JSCallback(
	(id, action) => {
		seen.push((new CString(action).toString() || "").trim());
	},
	{ args: [FFIType.u32, FFIType.cstring], returns: FFIType.void },
);
const call = CFunction({
	ptr: trayItemHandler.ptr,
	args: [FFIType.u32, FFIType.ptr],
	returns: FFIType.void,
});
call(1, ptr(Buffer.from("quit\\0")));
call(2, null);
console.log(JSON.stringify(seen));
`,
  );
  try {
    hardenElectrobunCallbackStrings(root);
    const result = spawnSync("bun", [path.join(root, "dist", NATIVE)], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '["quit",""]');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
