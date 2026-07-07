/**
 * Static scan that finds writers of a SHELL-RESERVED localStorage key (`eliza:` /
 * `elizaos:` / `eliza_`) that do NOT go through the privileged channel — the
 * mechanical enforcement for the surface-realm raw-global guards (#13452).
 *
 * The guard (`surface-realm-broker.ts`) is a realm-wide Proxy over
 * `window.localStorage`, so ANY raw reserved-key write throws
 * `SurfaceRealmDeniedError` while a view scope is foreground and the writer's own
 * `try/catch` swallows it into silent persistence loss. Every shell writer of a
 * reserved key must therefore go through `shellLocalStorage` /
 * `runAsPrivilegedShell` (the `surface-realm-channel` leaf). Per-writer positive
 * tests cannot catch a MISSED writer; this scan can, converting the whack-a-mole
 * into a one-time sweep plus a permanent regression guard.
 *
 * To be both complete and false-positive-free it:
 *   - strips comments (a `localStorage.setItem("eliza:…")` in a docstring is not
 *     a call) while preserving string/template contents;
 *   - resolves the receiver — `window.localStorage`, a `storage()` accessor that
 *     returns it, and locals bound to either;
 *   - resolves the key PER FILE with import-following (a same-named `STORAGE_KEY`
 *     is "cloud.lang" in one file and "eliza:cloud-handoff-pending" in another —
 *     a global name map would false-positive), through string literals,
 *     `const NAME = "eliza:…"`, template/prefix chains (`` `${STORAGE_PREFIX}:…` ``),
 *     reserved-key builder calls, and a helper's caller-supplied key param that a
 *     same-file/importing call site passes a reserved key to (`writeJson(key)` ←
 *     `writeJson(CONVERSATIONS_KEY, …)`);
 *   - exempts a write already wrapped in `runAsPrivilegedShell(() => …)` (the
 *     sanctioned form the channel itself uses).
 *
 * Reads are never guarded and are ignored; `sessionStorage` and non-reserved
 * keys correctly stay raw. Exported for the vitest guard and runnable directly;
 * prints every offending `file:line` and exits non-zero when any exist.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const SCAN_ROOTS = [
  join(REPO_ROOT, "packages", "ui", "src"),
  join(REPO_ROOT, "packages", "app", "src"),
];

const RESERVED = /^(?:eliza:|elizaos:|eliza_)/;
const ALLOWED_FILES = new Set([
  "surface-realm-broker.ts",
  "surface-realm-channel.ts",
]);
const IDENT = "[A-Za-z_$][\\w$]*";

function isSkipped(path) {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(path) ||
    /\.stories\.[tj]sx?$/.test(path) ||
    path.includes("/__tests__/") ||
    path.includes("/__mocks__/") ||
    path.includes("/__e2e__/")
  );
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[tj]sx?$/.test(full) && !isSkipped(full)) out.push(full);
  }
}

/**
 * Blank out `//` and block comments with spaces, preserving newlines (and thus
 * every byte offset + line number) and string/template literal bodies — so a
 * reported `file:line` matches the on-disk file exactly.
 */
function stripComments(src) {
  let out = "";
  const blank = (s) => s.replace(/[^\n]/g, " ");
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i += 1;
      out += blank(src.slice(start, i));
      i -= 1;
    } else if (c === "/" && n === "*") {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 1;
      out += blank(src.slice(start, i + 1));
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < src.length && src[i] !== c) {
        out += src[i];
        if (src[i] === "\\") {
          out += src[i + 1] ?? "";
          i += 1;
        }
        i += 1;
      }
      out += src[i] ?? "";
    } else out += c;
  }
  return out;
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const cands = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Per-file: stripped source, local const defs, and resolved named imports. */
function indexFiles(files) {
  const idx = new Map();
  const constDef = new RegExp(
    `\\b(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*([^;\\n]+)`,
    "g",
  );
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const defs = new Map();
    for (const m of src.matchAll(constDef))
      if (!defs.has(m[1])) defs.set(m[1], m[2].trim());
    const imports = new Map();
    for (const m of src.matchAll(importRe)) {
      const target = resolveImport(file, m[2]);
      if (!target) continue;
      for (const part of m[1].split(",")) {
        const t = part.trim();
        if (!t) continue;
        const as = t.match(new RegExp(`^(${IDENT})\\s+as\\s+(${IDENT})$`));
        if (as) imports.set(as[2], { file: target, name: as[1] });
        else if (new RegExp(`^${IDENT}$`).test(t))
          imports.set(t, { file: target, name: t });
      }
    }
    idx.set(file, { src, defs, imports });
  }
  return idx;
}

export function findRawReservedStorageWriters() {
  const files = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const idx = indexFiles(files);

  /** Does identifier `name` (in `file`) resolve to a reserved-prefix key? */
  function identReserved(name, file, seen = new Set()) {
    const key = `${file}#${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const rec = idx.get(file);
    if (!rec) return false;
    if (rec.defs.has(name)) return rhsReserved(rec.defs.get(name), file, seen);
    const imp = rec.imports.get(name);
    if (imp && idx.has(imp.file))
      return identReserved(imp.name, imp.file, seen);
    return false;
  }

  function rhsReserved(rhs, file, seen) {
    if (!rhs) return false;
    const q = rhs[0];
    if (q === '"' || q === "'") return RESERVED.test(rhs.slice(1));
    if (q === "`") {
      const body = rhs.slice(1);
      if (RESERVED.test(body)) return true;
      const lead = body.match(new RegExp(`^\\$\\{\\s*(${IDENT})\\s*\\}`));
      return lead ? identReserved(lead[1], file, seen) : false;
    }
    const head = rhs.match(new RegExp(`^(${IDENT})`));
    return head ? identReserved(head[1], file, seen) : false;
  }

  /** "reserved" | "unresolved" for a key argument evaluated in `file`. */
  function classifyKey(arg, file) {
    if (!arg) return "unresolved";
    const q = arg[0];
    if (q === '"' || q === "'")
      return RESERVED.test(arg.slice(1)) ? "reserved" : "unresolved";
    if (q === "`")
      return rhsReserved(arg, file, new Set()) ? "reserved" : "unresolved";
    if (new RegExp(`^${IDENT}$`).test(arg))
      return identReserved(arg, file) ? "reserved" : "unresolved";
    // builder call or expression: reserved if any component ident resolves reserved
    for (const id of arg.match(/[A-Za-z_$][\w$]*/g) ?? [])
      if (builderReserved(id, file) || identReserved(id, file))
        return "reserved";
    return "unresolved";
  }

  // Reserved-key builders: function/arrow returning a reserved template head.
  const builders = new Map(); // name -> Set(definingFiles)
  const fnDecl = new RegExp(
    `\\bfunction\\s+(${IDENT})\\s*\\([^)]*\\)\\s*(?::[^{]+)?\\{([\\s\\S]*?)\\n\\}`,
    "g",
  );
  const arrowDecl = new RegExp(
    `\\b(?:export\\s+)?const\\s+(${IDENT})\\s*=\\s*\\([^)]*\\)\\s*(?::[^=]+)?=>\\s*(\`[^\`]*\`)`,
    "g",
  );
  for (const [file, rec] of idx) {
    for (const m of rec.src.matchAll(fnDecl)) {
      const ret = m[2].match(/return\s+(`[^`]*`)/);
      if (ret && rhsReserved(ret[1], file, new Set()))
        builders.set(m[1], (builders.get(m[1]) ?? new Set()).add(file));
    }
    for (const m of rec.src.matchAll(arrowDecl))
      if (rhsReserved(m[2], file, new Set()))
        builders.set(m[1], (builders.get(m[1]) ?? new Set()).add(file));
  }
  function builderReserved(name, file) {
    const defs = builders.get(name);
    if (!defs) return false;
    if (defs.has(file)) return true;
    const imp = idx.get(file)?.imports.get(name);
    return imp ? defs.has(imp.file) : false;
  }

  // Storage accessors: functions/arrows returning window.localStorage.
  const accessors = new Set();
  const returnsLS = (b) =>
    /return[^;]*\b(?:window|globalThis)\.localStorage\b/.test(b) ||
    /=>\s*[^;{]*\b(?:window|globalThis)\.localStorage\b/.test(b);
  for (const [, rec] of idx) {
    for (const m of rec.src.matchAll(fnDecl))
      if (returnsLS(m[2])) accessors.add(m[1]);
    for (const m of rec.src.matchAll(
      new RegExp(
        `\\bconst\\s+(${IDENT})\\s*=\\s*\\([^)]*\\)\\s*(?::[^=]+)?=>\\s*([^;\\n]+)`,
        "g",
      ),
    ))
      if (returnsLS(m[2])) accessors.add(m[1]);
  }

  const receiverBefore = (src, dotIdx) => {
    let i = dotIdx - 1;
    while (i >= 0 && /\s/.test(src[i])) i -= 1;
    if (src[i] === "?") i -= 1;
    const end = i + 1;
    if (src[i] === ")") {
      let d = 0;
      for (; i >= 0; i -= 1) {
        if (src[i] === ")") d += 1;
        else if (src[i] === "(") {
          d -= 1;
          if (d === 0) {
            i -= 1;
            break;
          }
        }
      }
    }
    while (i >= 0 && /[\w$.?]/.test(src[i])) i -= 1;
    return src.slice(i + 1, end).trim();
  };

  const callArgs = (src, openParenIdx) => {
    const args = [];
    let depth = 1;
    let i = openParenIdx + 1;
    let start = i;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") {
        depth -= 1;
        if (depth === 0) {
          args.push(src.slice(start, i).trim());
          break;
        }
      } else if (depth === 1 && c === ",") {
        args.push(src.slice(start, i).trim());
        start = i + 1;
      } else if (c === '"' || c === "'" || c === "`") {
        i += 1;
        while (i < src.length && src[i] !== c) {
          if (src[i] === "\\") i += 1;
          i += 1;
        }
      }
    }
    return args;
  };

  const isStorageReceiver = (recv, storageVars) => {
    if (/(^|\.)localStorage$/.test(recv)) return true;
    const call = recv.match(new RegExp(`^(${IDENT})\\s*\\(\\s*\\)$`));
    if (call && accessors.has(call[1])) return true;
    return storageVars.has(recv);
  };

  // A write wrapped in `runAsPrivilegedShell(() => …)` is the sanctioned form —
  // the statement (back to the last `;{}` boundary) names it.
  const inPrivileged = (src, writeIdx) => {
    let b = writeIdx;
    while (b > 0 && !";{}".includes(src[b - 1])) b -= 1;
    return src.slice(b, writeIdx).includes("runAsPrivilegedShell");
  };

  const enclosingFn = (src, at) => {
    let best = null;
    for (const m of src
      .slice(0, at)
      .matchAll(new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(([^)]*)\\)`, "g")))
      best = m;
    if (!best) return null;
    const params = best[2]
      .split(",")
      .map((p) => p.trim().split(/[:=]/)[0].trim())
      .filter(Boolean);
    return { name: best[1], params };
  };

  const WRITER = /\??\.\s*(setItem|removeItem)\s*\(/g;
  const violations = [];
  const paramHelpers = [];

  for (const [file, rec] of idx) {
    if (ALLOWED_FILES.has(file.split("/").pop())) continue;
    const { src } = rec;
    const storageVars = new Set();
    for (const m of src.matchAll(
      new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*([^;\\n]+)`, "g"),
    )) {
      const rhs = m[2].trim();
      const call = rhs.match(new RegExp(`^(${IDENT})\\s*\\(\\s*\\)`));
      if (/(^|\.)localStorage\b/.test(rhs) || (call && accessors.has(call[1])))
        storageVars.add(m[1]);
    }

    for (const m of src.matchAll(WRITER)) {
      if (inPrivileged(src, m.index)) continue;
      const dotIdx = src.lastIndexOf(".", m.index + 1);
      const recv = receiverBefore(src, dotIdx);
      if (!isStorageReceiver(recv, storageVars)) continue;
      const op = m[1];
      const key = callArgs(src, m.index + m[0].length - 1)[0] ?? "";
      const line = src.slice(0, m.index).split("\n").length;
      if (classifyKey(key, file) === "reserved") {
        violations.push({ file: relative(REPO_ROOT, file), line, op, key });
        continue;
      }
      if (new RegExp(`^${IDENT}$`).test(key)) {
        const fn = enclosingFn(src, m.index);
        const pIdx = fn ? fn.params.indexOf(key) : -1;
        if (fn && pIdx >= 0)
          paramHelpers.push({ file, line, op, fn: fn.name, pIdx });
      }
    }
  }

  // Resolve param-key helpers via call sites in the same file OR files importing
  // the helper from it — scoped so a same-named helper elsewhere cannot bleed in.
  for (const h of paramHelpers) {
    const callSites = [{ file: h.file }];
    for (const [file, rec] of idx) {
      const imp = rec.imports.get(h.fn);
      if (imp && imp.file === h.file) callSites.push({ file });
    }
    let flagged = false;
    const callRe = new RegExp(`\\b${h.fn}\\s*\\(`, "g");
    for (const cs of callSites) {
      const rec = idx.get(cs.file);
      for (const cm of rec.src.matchAll(callRe)) {
        const args = callArgs(rec.src, cm.index + cm[0].length - 1);
        if (classifyKey(args[h.pIdx] ?? "", cs.file) === "reserved") {
          flagged = true;
          break;
        }
      }
      if (flagged) break;
    }
    if (flagged)
      violations.push({
        file: relative(REPO_ROOT, h.file),
        line: h.line,
        op: h.op,
        key: `<param of ${h.fn}() — a call site passes a reserved key>`,
      });
  }

  violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1,
  );
  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = findRawReservedStorageWriters();
  if (v.length === 0) {
    console.log("[surface-realm-writers] OK — no raw reserved-key writers");
    process.exit(0);
  }
  console.error(
    `[surface-realm-writers] ${v.length} raw reserved-key writer(s) — route through shellLocalStorage / runAsPrivilegedShell:`,
  );
  for (const it of v) {
    const k = it.key.length > 64 ? `${it.key.slice(0, 61)}…` : it.key;
    console.error(`  ${it.file}:${it.line}  .${it.op}(${k})`);
  }
  process.exit(1);
}
