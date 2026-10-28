import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import {
  assertAndroidDocumentLibrary,
  assertArm64Library,
  extractVerifiedPackage,
  stageAndroidDocuments,
  verifyAndroidDocuments,
  verifyPackagedAndroidDocuments,
} from "./android-documents.mjs";

test("document archive integrity is checked before extraction and symlinks are refused", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "document-package-test-"));
  try {
    fs.mkdirSync(path.join(temp, "package"));
    fs.writeFileSync(path.join(temp, "package/index.js"), "export {};");
    const archive = path.join(temp, "package.tgz");
    tar.c({ file: archive, cwd: temp, gzip: true, sync: true }, ["package"]);
    const integrity = () =>
      `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`;
    const output = path.join(temp, "output");
    assert.throws(
      () => extractVerifiedPackage(archive, "sha512-AAAA", output),
      /integrity/,
    );
    assert.equal(fs.existsSync(output), false);
    extractVerifiedPackage(archive, integrity(), output);
    assert.equal(
      fs.readFileSync(path.join(output, "index.js"), "utf8"),
      "export {};",
    );
    fs.symlinkSync("/tmp", path.join(temp, "package/escape"));
    tar.c({ file: archive, cwd: temp, gzip: true, sync: true }, ["package"]);
    assert.throws(
      () =>
        extractVerifiedPackage(archive, integrity(), path.join(temp, "unsafe")),
      /Unsafe/,
    );
    assert.equal(fs.existsSync(path.join(temp, "unsafe")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("document library rejects host Mach-O and wrong ELF architecture", () => {
  const elf = Buffer.alloc(64);
  elf.write("7f454c46", 0, "hex");
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(183, 18);
  assert.doesNotThrow(() => assertArm64Library(elf));
  elf.writeUInt16LE(62, 18);
  assert.throws(() => assertArm64Library(elf), /AArch64/);
  assert.throws(
    () => assertArm64Library(Buffer.from("cffaedfe", "hex")),
    /AArch64/,
  );
});
test("optional Android documents fail closed when files lack a manifest", () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-manifest-test-"),
  );
  try {
    assert.equal(verifyAndroidDocuments(temp), null);
    const gateway = path.join(
      temp,
      "android/app/src/main/assets/agent/gateway",
    );
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, "document-services.mjs"), "export {};");
    assert.throws(() => verifyAndroidDocuments(temp), /manifest missing/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("Android document admission checks bytes and task source before packaging", () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-admission-test-"),
  );
  try {
    const main = path.join(temp, "android/app/src/main");
    const prefix = "assets/agent/gateway/";
    const commit = "a".repeat(40);
    const elf = Buffer.alloc(64);
    elf.write("7f454c46", 0, "hex");
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(3, 16);
    elf.writeUInt16LE(183, 18);
    const contents = {
      [`${prefix}document-services.mjs`]: "export {};",
      [`${prefix}document-services.mjs.json`]: JSON.stringify({
        sourceCommit: commit,
      }),
      [`${prefix}node_modules/@napi-rs/canvas/package.json`]: "{}",
      "jniLibs/arm64-v8a/libeliza_canvas.so": elf,
    };
    const files = Object.entries(contents).map(([name, bytes]) => {
      fs.mkdirSync(path.dirname(path.join(main, name)), { recursive: true });
      fs.writeFileSync(path.join(main, name), bytes);
      return {
        path: name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    fs.writeFileSync(
      path.join(main, prefix, "document-services.manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        target: "linux-arm64-musl",
        sourceCommit: commit,
        files,
      }),
    );
    const task = path.join(main, prefix, "task-runtime.mjs.json");
    fs.writeFileSync(task, JSON.stringify({ sourceCommit: commit }));
    assert.equal(verifyAndroidDocuments(temp).sourceCommit, commit);
    const stale = path.join(
      main,
      prefix,
      "node_modules/@napi-rs/canvas/stale.js",
    );
    fs.writeFileSync(stale, "export {};");
    assert.throws(
      () => verifyAndroidDocuments(temp),
      /Unlisted document runtime file/,
    );
    fs.rmSync(stale);
    fs.writeFileSync(task, JSON.stringify({ sourceCommit: "b".repeat(40) }));
    assert.throws(() => verifyAndroidDocuments(temp), /source mismatch/);
    fs.writeFileSync(task, JSON.stringify({ sourceCommit: commit }));
    fs.appendFileSync(
      path.join(main, prefix, "document-services.mjs"),
      "changed",
    );
    assert.throws(() => verifyAndroidDocuments(temp), /file mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("caller cancellation rejects staging before reading source or publishing files", async () => {
  const controller = new AbortController();
  const reason = new Error("Caller stopped document packaging");
  controller.abort(reason);
  await assert.rejects(
    stageAndroidDocuments("/missing-output", "/missing-source", {
      sourceCommit: "a".repeat(40),
      canvasVersion: "0.1.100",
      lockedPackages: {},
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
});

test("both Android ABIs stage locked archives and verify packaged bytes without accepting mixed targets", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "document-abis-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, value);
  };
  write(
    path.join(source, "plugins/plugin-pdf/index.ts"),
    "export class PdfService {}\n",
  );
  write(
    path.join(source, "plugins/plugin-elizacloud/src/models/image.ts"),
    "export const handleImageDescription = () => {};\n",
  );
  write(
    path.join(source, "plugins/plugin-elizacloud/src/utils/config.ts"),
    "export const resolveCloudSdkAuthorityTuple = () => {}; export const getNativeApplicationSlot = () => {}; export const getAppId = () => {};\n",
  );
  write(
    path.join(
      source,
      "plugins/plugin-pdf/node_modules/@napi-rs/canvas/package.json",
    ),
    JSON.stringify({ version: "0.1.100" }),
  );
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "controlled document source",
  );
  const commit = git("rev-parse", "HEAD");
  const archives = new Map(),
    lockedPackages = {};
  const archive = (name, files) => {
    const dir = fs.mkdtempSync(path.join(temp, "package-"));
    for (const [file, bytes] of Object.entries({
      "package.json": JSON.stringify({ name, version: "0.1.100" }),
      ...files,
    }))
      write(path.join(dir, "package", file), bytes);
    const tarball = path.join(dir, "archive.tgz");
    tar.c({ file: tarball, cwd: dir, gzip: true, sync: true }, ["package"]);
    const bytes = fs.readFileSync(tarball),
      resolved = `https://registry.npmjs.org/${name}/-/fixture.tgz`;
    archives.set(resolved, bytes);
    lockedPackages[name] = {
      version: "0.1.100",
      resolved,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  };
  archive("@napi-rs/canvas", {
    "js-binding.js":
      "function requireNative() {\n  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {\n    try {\n      return require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH)\n    } catch (err) {\n      loadErrors.push(err)\n    }\n  }\n}\n",
  });
  const elf = (machine) => {
    const bytes = Buffer.alloc(64);
    bytes.write("7f454c46", 0, "hex");
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(3, 16);
    bytes.writeUInt16LE(machine, 18);
    return bytes;
  };
  archive("@napi-rs/canvas-linux-arm64-musl", {
    "skia.linux-arm64-musl.node": elf(183),
  });
  archive("@napi-rs/canvas-linux-x64-musl", {
    "skia.linux-x64-musl.node": elf(62),
  });
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(url);
    assert.ok(archives.has(url));
    return new Response(archives.get(url));
  });
  for (const [targetAbi, target, machine, other] of [
    ["arm64-v8a", "linux-arm64-musl", 183, "x86_64"],
    ["x86_64", "linux-x64-musl", 62, "arm64-v8a"],
  ]) {
    const output = path.join(temp, targetAbi),
      main = path.join(output, "android/app/src/main");
    write(
      path.join(main, "assets/agent/gateway/task-runtime.mjs.json"),
      JSON.stringify({ sourceCommit: commit }),
    );
    const options = targetAbi === "arm64-v8a" ? {} : { targetAbi };
    const manifest = await stageAndroidDocuments(output, source, {
      ...options,
      sourceCommit: commit,
      canvasVersion: "0.1.100",
      lockedPackages,
    });
    assert.equal(manifest.target, target);
    assert.deepEqual(requested.splice(0), [
      lockedPackages["@napi-rs/canvas"].resolved,
      lockedPackages[`@napi-rs/canvas-${target}`].resolved,
    ]);
    assert.equal(verifyAndroidDocuments(output, options).sourceCommit, commit);
    assert.match(
      fs.readFileSync(
        path.join(
          main,
          "assets/agent/gateway/node_modules/@napi-rs/canvas/js-binding.js",
        ),
        "utf8",
      ),
      /process\.dlopen/,
    );
    assertAndroidDocumentLibrary(
      fs.readFileSync(
        path.join(main, `jniLibs/${targetAbi}/libeliza_canvas.so`),
      ),
      targetAbi,
    );
    assert.throws(
      () => assertAndroidDocumentLibrary(elf(machine), other),
      /shared object/,
    );
    const apk = new Map(
      manifest.files.map((file) => [
        file.path.replace(/^jniLibs\//, "lib/"),
        fs.readFileSync(path.join(main, file.path)),
      ]),
    );
    const manifestName = "assets/agent/gateway/document-services.manifest.json";
    apk.set(manifestName, Buffer.from(JSON.stringify(manifest)));
    const verify = () =>
      verifyPackagedAndroidDocuments(
        [...apk.keys()],
        (name) => apk.get(name),
        options,
      );
    assert.equal(verify().target, target);
    assert.throws(
      () =>
        verifyPackagedAndroidDocuments(
          [...apk.keys()],
          (name) => apk.get(name),
          { targetAbi: other },
        ),
      /Invalid APK document manifest/,
    );
    apk.set(`lib/${other}/libeliza_canvas.so`, elf(machine));
    assert.throws(verify, /Mixed APK document ABIs/);
    apk.delete(`lib/${other}/libeliza_canvas.so`);
    apk.set(`lib/${targetAbi}/libeliza_canvas.so`, Buffer.from("changed"));
    assert.throws(verify, /bytes mismatch/);
    const wrongElf = elf(machine === 62 ? 183 : 62);
    apk.set(`lib/${targetAbi}/libeliza_canvas.so`, wrongElf);
    const wrongManifest = structuredClone(manifest);
    wrongManifest.files.find(
      (file) => file.path === `jniLibs/${targetAbi}/libeliza_canvas.so`,
    ).sha256 = createHash("sha256").update(wrongElf).digest("hex");
    apk.set(manifestName, Buffer.from(JSON.stringify(wrongManifest)));
    assert.throws(verify, /shared object/);
    write(path.join(main, `jniLibs/${other}/libeliza_canvas.so`), elf(machine));
    assert.throws(
      () => verifyAndroidDocuments(output, options),
      /Mixed Android document ABIs/,
    );
    await assert.rejects(
      stageAndroidDocuments(output, source, {
        ...options,
        sourceCommit: commit,
        canvasVersion: "0.1.100",
        lockedPackages,
      }),
      /Mixed Android document ABIs/,
    );
  }
  archive("@napi-rs/canvas-linux-x64-musl", {
    "skia.linux-x64-musl.node": elf(183),
  });
  const wrongOutput = path.join(temp, "wrong-elf");
  write(
    path.join(
      wrongOutput,
      "android/app/src/main/assets/agent/gateway/task-runtime.mjs.json",
    ),
    JSON.stringify({ sourceCommit: commit }),
  );
  await assert.rejects(
    stageAndroidDocuments(wrongOutput, source, {
      targetAbi: "x86_64",
      sourceCommit: commit,
      canvasVersion: "0.1.100",
      lockedPackages,
    }),
    /x86-64 shared object/,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        wrongOutput,
        "android/app/src/main/jniLibs/x86_64/libeliza_canvas.so",
      ),
    ),
    false,
  );
  await assert.rejects(
    stageAndroidDocuments("/missing", source, {
      targetAbi: "riscv64",
      lockedPackages,
    }),
    /Unsupported Android document ABI/,
  );
  assert.throws(
    () =>
      verifyPackagedAndroidDocuments(["lib/x86_64/libeliza_canvas.so"], () =>
        elf(62),
      ),
    /lacks its manifest/,
  );
});
