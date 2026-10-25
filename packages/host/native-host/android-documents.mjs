import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { buildDocumentRuntime } from "./build-document-runtime.mjs";
import { NativeHostError } from "./errors.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mainPath = "android/app/src/main";
const targets = {
  "arm64-v8a": {
    target: "linux-arm64-musl",
    machine: 183,
    architecture: "AArch64",
  },
  x86_64: { target: "linux-x64-musl", machine: 62, architecture: "x86-64" },
};
const selectTarget = (targetAbi) => {
  if (!Object.hasOwn(targets, targetAbi))
    throw new NativeHostError("Unsupported Android document ABI");
  return targets[targetAbi];
};
const nativePath = (targetAbi) => `jniLibs/${targetAbi}/libeliza_canvas.so`;
const isDocumentLibrary = (name) =>
  /^lib\/[^/]+\/libeliza_canvas\.so$/.test(name);
const stagedLibraries = (main) => {
  const root = path.join(main, "jniLibs");
  return fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((abi) =>
          fs.existsSync(path.join(root, abi, "libeliza_canvas.so")),
        )
        .map(nativePath)
    : [];
};
export function assertAndroidDocumentLibrary(bytes, targetAbi = "arm64-v8a") {
  const target = selectTarget(targetAbi);
  if (
    bytes.length < 64 ||
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(16) !== 3 ||
    bytes.readUInt16LE(18) !== target.machine
  )
    throw new NativeHostError(
      `Document library must be an ELF64 little-endian ${target.architecture} shared object`,
    );
}
export function assertArm64Library(bytes) {
  return assertAndroidDocumentLibrary(bytes);
}
export function extractVerifiedPackage(archive, integrity, destination) {
  const bytes = fs.readFileSync(archive);
  if (
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
      integrity
  )
    throw new NativeHostError("Document package integrity mismatch");
  let size = 0;
  const names = new Set();
  tar
    .t({
      sync: true,
      strict: true,
      onReadEntry(entry) {
        const name = entry.path.replace(/\/$/, "");
        if (
          !/^package(?:\/[A-Za-z0-9_.@-]+)*$/.test(name) ||
          name.split("/").some((part) => part === ".." || part === ".") ||
          !["File", "Directory"].includes(entry.type) ||
          names.has(name)
        )
          throw new NativeHostError("Unsafe document package entry");
        names.add(name);
        size += entry.size;
        if (size > 100 * 1024 ** 2)
          throw new NativeHostError("Document package is too large");
      },
    })
    .end(bytes);
  fs.mkdirSync(destination, { recursive: true });
  tar
    .x({
      cwd: destination,
      strip: 1,
      sync: true,
      strict: true,
    })
    .end(bytes);
}
export function verifyAndroidDocuments(
  output,
  { targetAbi = "arm64-v8a" } = {},
) {
  const target = selectTarget(targetAbi);
  const main = path.join(output, mainPath);
  const file = path.join(
    main,
    "assets/agent/gateway/document-services.manifest.json",
  );
  if (!fs.existsSync(file)) {
    if (
      fs.existsSync(
        path.join(main, "assets/agent/gateway/document-services.mjs"),
      ) ||
      stagedLibraries(main).length > 0
    )
      throw new NativeHostError("Document runtime manifest missing");
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(file));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== target.target ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  )
    throw new NativeHostError("Invalid document runtime manifest");
  const names = new Set();
  for (const item of manifest.files) {
    if (
      typeof item.path !== "string" ||
      !(
        item.path.startsWith("assets/agent/gateway/") ||
        item.path === nativePath(targetAbi)
      ) ||
      item.path.split("/").some((p) => !p || p === "." || p === "..") ||
      names.has(item.path)
    )
      throw new NativeHostError("Invalid document runtime file");
    names.add(item.path);
    const target = path.join(main, item.path);
    if (
      !fs.lstatSync(target).isFile() ||
      digest(fs.readFileSync(target)) !== item.sha256
    )
      throw new NativeHostError("Document runtime file mismatch");
  }
  for (const required of [
    "assets/agent/gateway/document-services.mjs",
    "assets/agent/gateway/document-services.mjs.json",
    "assets/agent/gateway/node_modules/@napi-rs/canvas/package.json",
    nativePath(targetAbi),
  ])
    if (!names.has(required))
      throw new NativeHostError("Incomplete document runtime manifest");
  // This package directory is exclusively owned by the document packager.
  // Refuse stale/unlisted files as well as symlinks inside it.
  const canvasRoot = "assets/agent/gateway/node_modules/@napi-rs/canvas";
  const inspect = (relative) => {
    const entry = path.join(main, relative);
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry))
        inspect(`${relative}/${child}`);
    } else if (!stat.isFile() || !names.has(relative)) {
      throw new NativeHostError("Unlisted document runtime file");
    }
  };
  inspect(canvasRoot);
  if (stagedLibraries(main).some((name) => name !== nativePath(targetAbi)))
    throw new NativeHostError("Mixed Android document ABIs");
  assertAndroidDocumentLibrary(
    fs.readFileSync(path.join(main, nativePath(targetAbi))),
    targetAbi,
  );
  const provenance = JSON.parse(
    fs.readFileSync(
      path.join(main, "assets/agent/gateway/document-services.mjs.json"),
    ),
  );
  const task = JSON.parse(
    fs.readFileSync(
      path.join(main, "assets/agent/gateway/task-runtime.mjs.json"),
    ),
  );
  if (
    provenance.sourceCommit !== manifest.sourceCommit ||
    task.sourceCommit !== manifest.sourceCommit
  )
    throw new NativeHostError("Document/task runtime source mismatch");
  return manifest;
}
export async function stageAndroidDocuments(
  output,
  source,
  {
    sourceCommit,
    canvasVersion,
    lockedPackages,
    signal,
    targetAbi = "arm64-v8a",
  },
) {
  signal?.throwIfAborted();
  const target = selectTarget(targetAbi);
  output = fs.realpathSync(output);
  if (
    stagedLibraries(path.join(output, mainPath)).some(
      (name) => name !== nativePath(targetAbi),
    )
  )
    throw new NativeHostError("Mixed Android document ABIs");
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-android-documents-"),
  );
  try {
    const main = path.join(temporary, mainPath);
    const gateway = path.join(main, "assets/agent/gateway");
    const provenance = buildDocumentRuntime(
      source,
      path.join(gateway, "document-services.mjs"),
      { sourceCommit, canvasVersion },
    );
    const packages = {};
    for (const name of [
      "@napi-rs/canvas",
      `@napi-rs/canvas-${target.target}`,
    ]) {
      const entry = lockedPackages[name];
      if (
        entry?.version !== provenance.canvasVersion ||
        !entry.resolved?.startsWith("https://registry.npmjs.org/")
      )
        throw new NativeHostError("Missing locked document dependency");
      const response = await fetch(entry.resolved, {
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new NativeHostError("Document package download failed");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > 50 * 1024 ** 2)
          throw new NativeHostError("Document archive is too large");
        chunks.push(chunk);
      }
      const archive = path.join(temporary, "package.tgz");
      fs.writeFileSync(archive, Buffer.concat(chunks));
      const destination = path.join(gateway, "node_modules", name);
      extractVerifiedPackage(archive, entry.integrity, destination);
      const meta = JSON.parse(
        fs.readFileSync(path.join(destination, "package.json")),
      );
      if (meta.name !== name || meta.version !== entry.version)
        throw new NativeHostError("Document package metadata mismatch");
      packages[name] = { version: entry.version, integrity: entry.integrity };
    }
    const canvasPatch = path.join(
      import.meta.dirname,
      "canvas-native-library-dlopen.patch",
    );
    execFileSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", canvasPatch], {
      cwd: path.join(gateway, "node_modules/@napi-rs/canvas"),
      stdio: "pipe",
    });
    const nativePackage = path.join(
      gateway,
      `node_modules/@napi-rs/canvas-${target.target}`,
    );
    const binary = fs.readFileSync(
      path.join(nativePackage, `skia.${target.target}.node`),
    );
    assertAndroidDocumentLibrary(binary, targetAbi);
    // Native code belongs in the APK's installed executable library directory.
    fs.rmSync(nativePackage, { recursive: true });
    fs.mkdirSync(path.join(main, "jniLibs", targetAbi), { recursive: true });
    fs.writeFileSync(path.join(main, nativePath(targetAbi)), binary);
    const files = [];
    const visit = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) visit(file);
        else
          files.push({
            path: path.relative(main, file).split(path.sep).join("/"),
            sha256: digest(fs.readFileSync(file)),
          });
      }
    };
    visit(main);
    const manifest = {
      schemaVersion: 1,
      target: target.target,
      sourceCommit: provenance.sourceCommit,
      packages,
      patches: { nativeLibraryDlopen: digest(fs.readFileSync(canvasPatch)) },
      files,
    };
    fs.writeFileSync(
      path.join(gateway, "document-services.manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // Check source compatibility before publishing any files into the runtime.
    const task = JSON.parse(
      fs.readFileSync(
        path.join(
          output,
          mainPath,
          "assets/agent/gateway/task-runtime.mjs.json",
        ),
      ),
    );
    if (task.sourceCommit !== provenance.sourceCommit)
      throw new NativeHostError(
        "Stage the current task gateway before document services",
      );
    signal?.throwIfAborted();
    fs.rmSync(
      path.join(
        output,
        mainPath,
        "assets/agent/gateway/node_modules/@napi-rs/canvas",
      ),
      { recursive: true, force: true },
    );
    fs.cpSync(main, path.join(output, mainPath), { recursive: true });
    verifyAndroidDocuments(output, { targetAbi });
    return manifest;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Verify the document component after APK packaging has remapped jniLibs to lib. */
export function verifyPackagedAndroidDocuments(
  entries,
  readEntry,
  { targetAbi = "arm64-v8a" } = {},
) {
  const target = selectTarget(targetAbi);
  const manifestName = "assets/agent/gateway/document-services.manifest.json";
  const library = `lib/${targetAbi}/libeliza_canvas.so`;
  const service = "assets/agent/gateway/document-services.mjs";
  if (!entries.includes(manifestName)) {
    if (entries.some(isDocumentLibrary) || entries.includes(service))
      throw new NativeHostError("APK document runtime lacks its manifest");
    return null;
  }
  if (entries.filter((name) => name === manifestName).length !== 1)
    throw new NativeHostError("Duplicate APK document manifest");
  let manifest;
  try {
    manifest = JSON.parse(readEntry(manifestName));
  } catch {
    throw new NativeHostError("Invalid APK document manifest");
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== target.target ||
    !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
    !Array.isArray(manifest.files)
  )
    throw new NativeHostError("Invalid APK document manifest");
  const selected = new Set();
  for (const item of manifest.files) {
    if (
      typeof item.path !== "string" ||
      !(
        item.path.startsWith("assets/agent/gateway/") ||
        item.path === nativePath(targetAbi)
      ) ||
      item.path.includes("\\") ||
      item.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      selected.has(item.path)
    )
      throw new NativeHostError("Invalid APK document path");
    selected.add(item.path);
    const name = item.path.replace(/^jniLibs\//, "lib/");
    if (
      entries.filter((entry) => entry === name).length !== 1 ||
      digest(readEntry(name)) !== item.sha256
    )
      throw new NativeHostError(`APK document bytes mismatch: ${name}`);
  }
  for (const name of [
    service,
    `${service}.json`,
    "assets/agent/gateway/node_modules/@napi-rs/canvas/package.json",
    nativePath(targetAbi),
  ])
    if (!selected.has(name))
      throw new NativeHostError("Incomplete APK document runtime");
  for (const name of entries) {
    if (
      name.startsWith("assets/agent/gateway/node_modules/@napi-rs/canvas/") &&
      !name.endsWith("/") &&
      !selected.has(name)
    )
      throw new NativeHostError("Unlisted APK document runtime file");
  }
  if (entries.some((name) => isDocumentLibrary(name) && name !== library))
    throw new NativeHostError("Mixed APK document ABIs");
  assertAndroidDocumentLibrary(readEntry(library), targetAbi);
  return {
    sourceCommit: manifest.sourceCommit,
    target: manifest.target,
    verifiedFiles: manifest.files.length,
  };
}
