import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Source {
  schemaVersion: number;
  baseCommit: string;
  patch: string;
  patchSha256: string;
  sourceRoots: string[];
  files: Record<string, string>;
}
interface Inventory {
  sourceRoots: string[];
  files: Record<string, string>;
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function relative(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    value
      .split("/")
      .every((part) => part !== ".." && part !== "." && part !== "")
  );
}

/** Additive overlays only: the pinned checkout is inspected, never modified. */
export function createSourceOverlay(options: {
  root: string;
  output: string;
  manifests: string[];
  pin?: string;
  checkout?: string;
  compose?: boolean;
  accepts: (file: string) => boolean;
}) {
  const { root, output, manifests, accepts, compose = false } = options;
  if (!manifests.length || (!compose && manifests.length !== 1))
    throw Error("Invalid overlay manifest selection");
  function specification() {
    const pin = JSON.parse(
      fs.readFileSync(
        path.resolve(root, options.pin ?? "upstream.lock.json"),
        "utf8",
      ),
    );
    const head = execFileSync(
      "git",
      [
        "-C",
        path.resolve(root, options.checkout ?? "vendor/eliza"),
        "rev-parse",
        "HEAD",
      ],
      { encoding: "utf8" },
    ).trim();
    const sources: Source[] = manifests.map((file) =>
      JSON.parse(fs.readFileSync(path.resolve(root, file), "utf8")),
    );
    const files: Record<string, string> = {},
      roots = new Set<string>(),
      patches: Buffer[] = [];
    for (const source of sources) {
      if (
        source.schemaVersion !== 1 ||
        source.baseCommit !== pin.commit ||
        head !== pin.commit
      )
        throw Error("Overlay base pin mismatch");
      if (
        !relative(source.patch) ||
        !Array.isArray(source.sourceRoots) ||
        !source.sourceRoots.length ||
        !source.sourceRoots.every(relative)
      )
        throw Error("Invalid overlay source path");
      const patch = fs.readFileSync(path.join(root, source.patch));
      if (digest(patch) !== source.patchSha256)
        throw Error("Overlay patch hash mismatch");
      for (const [file, hash] of Object.entries(source.files)) {
        if (
          !relative(file) ||
          !source.sourceRoots.some((dir) => file.startsWith(dir + "/")) ||
          !accepts(file) ||
          !/^[a-f0-9]{64}$/.test(hash)
        )
          throw Error("Invalid overlay file path or hash");
        if (Object.hasOwn(files, file))
          throw Error("Overlay sources must not replace each other");
        files[file] = hash;
      }
      for (const dir of source.sourceRoots) roots.add(dir);
      patches.push(patch);
    }
    const spec = compose
      ? { schemaVersion: 1, sources, sourceRoots: [...roots], files }
      : sources[0];
    if (!spec || !Object.keys(files).length)
      throw Error("Empty overlay inventory");
    return { spec, patch: Buffer.concat(patches) };
  }
  function verifyFiles(directory: string, spec: Inventory) {
    if (!fs.lstatSync(directory).isDirectory())
      throw Error("Overlay root must be a real directory");
    const found: Record<string, string> = {};
    function walk(parent: string) {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        const file = path.join(parent, entry.name),
          name = path.relative(directory, file).split(path.sep).join("/");
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && name !== "provenance.json")
          found[name] = digest(fs.readFileSync(file));
        else if (!entry.isFile())
          throw Error("Overlay cannot contain links or special files");
      }
    }
    walk(directory);
    if (
      Object.keys(found).length !== Object.keys(spec.files).length ||
      Object.entries(spec.files).some(([file, hash]) => found[file] !== hash)
    )
      throw Error("Overlay file inventory mismatch; restage the patch");
  }
  function verify(directory = output) {
    const { spec } = specification();
    verifyFiles(directory, spec);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(directory, "provenance.json"), "utf8"),
    );
    if (JSON.stringify(provenance) !== JSON.stringify(spec))
      throw Error("Overlay provenance mismatch");
    return spec.sourceRoots.map((dir) => path.join(directory, dir));
  }
  function publish(directory: string) {
    const { spec, patch } = specification();
    try {
      verify(directory);
      return directory;
    } catch {
      /* Invalid cached output is replaced after validation. */
    }
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-source-overlay-"),
    );
    try {
      execFileSync("git", ["apply", "--check", "-"], {
        cwd: temporary,
        input: patch,
      });
      execFileSync("git", ["apply", "-"], { cwd: temporary, input: patch });
      verifyFiles(temporary, spec);
      fs.writeFileSync(
        path.join(temporary, "provenance.json"),
        JSON.stringify(spec),
      );
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      fs.rmSync(directory, { recursive: true, force: true });
      fs.cpSync(temporary, directory, { recursive: true });
      return directory;
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  function stage(directory = output) {
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const lock = directory + ".lock",
      deadline = Date.now() + 30000;
    let fd: number | undefined;
    while (fd === undefined) {
      try {
        fd = fs.openSync(lock, "wx", 0o600);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          Date.now() >= deadline
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return publish(directory);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
  return { stage, verify };
}
