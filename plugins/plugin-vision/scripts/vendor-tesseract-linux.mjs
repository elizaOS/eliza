#!/usr/bin/env node
/**
 * Stage a PORTABLE tesseract into the app bundle so on-device/desktop OCR
 * "just ships and works" with no host `apt install tesseract-ocr` (#9105).
 *
 * Output layout (consumed by `ocr-service-linux-tesseract.ts` `resolveTesseract`
 * via `ELIZA_VISION_VENDOR_DIR`):
 *
 *   <out>/tesseract/
 *     bin/tesseract                 the CLI
 *     lib/libtesseract.so* liblept.so*   the shared libs (rest come from the host)
 *     tessdata/<lang>.traineddata   the language model(s)
 *     tessdata/configs/tsv ...      REQUIRED — tesseract reads the `tsv` output
 *                                   config from here; without configs/ the
 *                                   `tsv` arg silently fails ("Can't open tsv")
 *                                   and the OCR returns zero rows.
 *
 * Linux x64 only (the desktop build host). macOS uses Apple Vision, Windows uses
 * Windows.Media.Ocr, Android uses the native Tesseract4Android bridge — each
 * provider is platform-resolved in plugin-vision/src/index.ts.
 *
 * Usage: node scripts/vendor-tesseract-linux.mjs [--out <dir>] [--langs eng,...]
 * Build-time prereq: `apt-get download` works (no sudo needed — it only fetches
 * .debs); `dpkg-deb` extracts them. Run on the Linux build host.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const outDir = arg("--out", join(here, "..", "vendor"));
const langs = arg("--langs", "eng")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const dest = join(outDir, "tesseract");

if (process.platform !== "linux") {
  console.log(
    `[vendor-tesseract] non-linux host (${process.platform}); skipping (platform provider handles OCR).`,
  );
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "vendor-tess-"));
const pkgs = [
  "tesseract-ocr",
  "libtesseract5",
  "liblept5",
  ...langs.map((l) => `tesseract-ocr-${l}`),
];
console.log(`[vendor-tesseract] downloading: ${pkgs.join(", ")}`);
execFileSync("apt-get", ["download", ...pkgs], { cwd: work, stdio: "inherit" });

const root = join(work, "root");
for (const deb of readdirSync(work).filter((f) => f.endsWith(".deb"))) {
  execFileSync("dpkg-deb", ["-x", join(work, deb), root], { stdio: "inherit" });
}

mkdirSync(join(dest, "bin"), { recursive: true });
mkdirSync(join(dest, "lib"), { recursive: true });
mkdirSync(join(dest, "tessdata"), { recursive: true });

cpSync(join(root, "usr/bin/tesseract"), join(dest, "bin/tesseract"));
const libDir = join(root, "usr/lib/x86_64-linux-gnu");
for (const so of readdirSync(libDir).filter((f) =>
  /^(libtesseract|liblept)\.so/.test(f),
)) {
  // Dereference to the real .so bytes and write them under the SONAME name.
  // Debian ships libtesseract.so.5 etc. as symlinks into the extraction dir;
  // copying them as symlinks (dereference:false) leaves the bundle pointing at
  // a temp dir that is deleted on exit — the "portable" bundle then dlopen-fails
  // with "libtesseract.so.5: cannot open shared object file". Writing real bytes
  // under each name makes the bundle self-contained.
  const realSo = realpathSync(join(libDir, so));
  copyFileSync(realSo, join(dest, "lib", so));
}

// Copy the FULL transitive shared-lib closure. libtesseract pulls in leptonica,
// which pulls in libjpeg/png/tiff/webp/openjp2/gif/zlib/... — none of which the
// two .debs above provide. Without them the bundled binary dlopen-fails on a
// clean host, defeating the whole "no host install" goal. We let `ldd` resolve
// the binary's deps with the bundle's own lib/ on the search path (so it can
// find the libtesseract/leptonica we just staged and recurse into their deps),
// then copy every resolved .so EXCEPT the glibc/loader set that every Linux
// target is guaranteed to provide.
const GLIBC_PROVIDED =
  /^(ld-linux.*|linux-vdso|libc|libm|libdl|libpthread|librt|libresolv|libgcc_s|libstdc\+\+)\.so/;
function lddClosure(binPath) {
  let out = "";
  try {
    out = execFileSync("ldd", [binPath], {
      encoding: "utf8",
      env: { ...process.env, LD_LIBRARY_PATH: join(dest, "lib") },
    });
  } catch (err) {
    // `ldd` is glibc-only; on a musl/non-glibc build host we can't compute the
    // closure. Fail loud rather than silently shipping an incomplete bundle.
    throw new Error(
      `[vendor-tesseract] ldd failed (${err.message}); cannot compute the shared-lib closure on this host`,
    );
  }
  const resolved = [];
  for (const line of out.split("\n")) {
    const m = line.match(/=>\s*(\/\S+\.so\S*)/);
    if (m) resolved.push(m[1]);
  }
  return resolved;
}
let bundledExtra = 0;
for (const soPath of lddClosure(join(dest, "bin", "tesseract"))) {
  // ldd can resolve a path with a trailing slash (e.g. a symlink dir entry);
  // strip it so the SONAME basename is never empty (an empty basename made the
  // target the lib/ dir itself → cpSync EISDIR).
  const cleanSrc = soPath.replace(/\/+$/, "");
  const base = cleanSrc.split("/").pop();
  if (!base || GLIBC_PROVIDED.test(base)) continue;
  const target = join(dest, "lib", base);
  if (existsSync(target)) continue; // already staged (libtesseract/liblept)
  // dereference the symlink to the real .so file and copy its bytes under the
  // SONAME the binary asks for, so the dynamic loader finds it by that name.
  const realSrc = realpathSync(cleanSrc);
  if (!statSync(realSrc).isFile()) continue;
  copyFileSync(realSrc, target);
  bundledExtra++;
}
console.log(
  `[vendor-tesseract] bundled ${bundledExtra} transitive shared lib(s) via ldd closure.`,
);

// tessdata lives under usr/share/tesseract-ocr/<ver>/tessdata — copy the WHOLE
// dir (traineddata + the REQUIRED configs/ + tessconfigs/). Pick the HIGHEST
// version dir (numeric-aware) so a host with multiple tesseract data versions
// installed stages the newest, not whichever readdir happens to list first.
const shareTess = join(root, "usr/share/tesseract-ocr");
const ver = readdirSync(shareTess)
  .filter((d) => existsSync(join(shareTess, d, "tessdata")))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
if (!ver)
  throw new Error(
    "[vendor-tesseract] tessdata not found in downloaded package",
  );
cpSync(join(shareTess, ver, "tessdata"), join(dest, "tessdata"), {
  recursive: true,
});

if (!existsSync(join(dest, "tessdata", "configs", "tsv"))) {
  throw new Error(
    "[vendor-tesseract] tessdata/configs/tsv missing — TSV OCR output would fail",
  );
}
for (const l of langs) {
  if (!existsSync(join(dest, "tessdata", `${l}.traineddata`))) {
    throw new Error(`[vendor-tesseract] ${l}.traineddata missing`);
  }
}
console.log(
  `[vendor-tesseract] staged portable tesseract → ${dest} (langs: ${langs.join(", ")})`,
);
console.log(
  `[vendor-tesseract] set ELIZA_VISION_VENDOR_DIR=${outDir} so the runtime resolves it.`,
);
