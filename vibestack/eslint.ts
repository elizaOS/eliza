import { existsSync, globSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, matchesGlob, posix, resolve, sep } from "node:path"

interface SourcePos {
  readonly line: number
  readonly column: number
}

interface SourceLoc {
  readonly start: SourcePos
  readonly end: SourcePos
}

interface EslintComment {
  readonly value: string
  readonly loc: SourceLoc
}

interface EslintParser {
  readonly meta?: { readonly name?: string; readonly version?: string }
  parseForESLint(text: string, options?: unknown): {
    readonly ast: { readonly comments?: readonly EslintComment[]; readonly [key: string]: unknown }
    readonly [key: string]: unknown
  }
}

/** Minimal structural shape of an ESLint flat-config entry. */
export interface FlatConfig {
  name?: string | undefined
  basePath?: string | undefined
  files?: (string | string[])[] | undefined
  ignores?: string[] | undefined
  language?: string | undefined
  languageOptions?: {
    parser?: object | undefined
    parserOptions?: object | undefined
  } | undefined
  plugins?: object | undefined
  rules?: object | undefined
}

/** Options for {@link withWorkspaceBarrels}. */
export interface WorkspaceBarrelsOptions {
  /** Repository root containing `pnpm-workspace.yaml` (or `package.json#workspaces`), typically `import.meta.dirname`. */
  readonly root: string
  /** Existing non-barrel `exports` keys temporarily allowed per repo-relative manifest POSIX path. */
  readonly allowExports?: Readonly<Record<string, readonly string[]>>
  /** Existing non-barrel import specifiers temporarily allowed per repo-relative source file POSIX path. */
  readonly allowImports?: Readonly<Record<string, readonly string[]>>
}

type RelPath = string & { readonly __brand: "RelPath" }
type PackageName = string & { readonly __brand: "PackageName" }
type Subpath = string & { readonly __brand: "Subpath" }
type SubpathSpecifier = string & { readonly __brand: "SubpathSpecifier" }

type JsonNode =
  | { readonly kind: "object"; readonly properties: readonly JsonProperty[]; readonly loc: SourceLoc }
  | { readonly kind: "array"; readonly elements: readonly JsonNode[]; readonly loc: SourceLoc }
  | { readonly kind: "string"; readonly value: string; readonly loc: SourceLoc }
  | { readonly kind: "primitive"; readonly value: number | boolean | null; readonly loc: SourceLoc }

interface JsonProperty {
  readonly key: string
  readonly keyLoc: SourceLoc
  readonly value: JsonNode
}

type ExportsField =
  | { readonly kind: "absent" }
  | { readonly kind: "barrel"; readonly loc: SourceLoc }
  | { readonly kind: "subpath-map"; readonly loc: SourceLoc; readonly entries: readonly JsonProperty[] }
  | { readonly kind: "invalid"; readonly loc: SourceLoc }

type SubpathVerdict =
  | { readonly kind: "barrel" }
  | { readonly kind: "blocked" }
  | { readonly kind: "asset" }
  | { readonly kind: "forbidden"; readonly reason: "wildcard" | "code-subpath" | "non-asset-target"; readonly loc: SourceLoc }

interface WorkspaceGlobs {
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

interface WorkspacePackage {
  readonly name: PackageName
  readonly manifestPath: RelPath
  readonly allowedAssetSubpaths: ReadonlySet<Subpath>
}

interface WorkspaceIndex {
  readonly root: string
  readonly manifestFiles: readonly string[]
  readonly manifestIgnores: readonly string[]
  readonly packages: ReadonlyMap<PackageName, WorkspacePackage>
}

interface NormalizedRatchet {
  readonly exports: ReadonlyMap<RelPath, ReadonlySet<Subpath>>
  readonly imports: ReadonlyMap<RelPath, ReadonlySet<SubpathSpecifier>>
}

interface AstNode {
  readonly type: string
  readonly loc: SourceLoc
  readonly [key: string]: unknown
}

interface LintContext {
  readonly cwd: string
  readonly filename: string
  readonly sourceCode: { readonly parserServices?: { readonly manifest?: JsonNode } }
  report(problem: { readonly node?: AstNode; readonly loc?: SourceLoc; readonly message: string }): void
}

const ASSET_EXTENSIONS: readonly string[] = [
  ".css", ".scss", ".sass", ".less",
  ".json",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm",
]

const TYPE_DECL_EXTENSIONS: readonly string[] = [".d.ts", ".d.mts", ".d.cts"]

const DEFAULT_SCAN_EXCLUDES: readonly string[] = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/gen/**",
  "**/.spec-cache/**",
  "**/.cache/**",
  "**/.turbo/**",
  "**/.alchemy/**",
  "**/.wrangler/**",
  "**/storybook-static/**",
  "**/test/fixtures/**",
]

const GLOBAL_IGNORE_KEYS = new Set(["ignores", "name", "basePath"])
const guardedParsers = new WeakMap<EslintParser, EslintParser>()
const protectedParsers = new WeakSet<EslintParser>()

function toPosix(filePath: string): string {
  return filePath.split(sep).join("/")
}

function canonicalPath(targetPath: string): string {
  const abs = resolve(targetPath)
  if (existsSync(abs)) return realpathSync(abs)
  let current = dirname(abs)
  const tail: string[] = [abs.slice(current.length === 1 ? 1 : current.length + 1)]
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return abs
    tail.unshift(current.slice(parent.length === 1 ? 1 : parent.length + 1))
    current = parent
  }
  return join(realpathSync(current), ...tail)
}

function relativePosixPath(canonicalRoot: string, cwd: string, filename: string): RelPath | undefined {
  if (!filename || filename === "<input>" || filename === "<text>") return undefined
  const fileAbs = canonicalPath(resolve(cwd, filename))
  const rel = toPosix(posix.relative(toPosix(canonicalRoot), toPosix(fileAbs)))
  if (!rel || rel.startsWith("../") || rel === ".." || posix.isAbsolute(rel)) return undefined
  return rel as RelPath
}

function hasExtension(target: string, extensions: readonly string[]): boolean {
  const lower = target.toLowerCase()
  const slash = lower.lastIndexOf("/")
  const base = slash >= 0 ? lower.slice(slash + 1) : lower
  return extensions.some((ext) => base.length > ext.length && base.endsWith(ext))
}

function parseJsonDocument(text: string): { readonly root: JsonNode; readonly end: SourcePos } {
  const len = text.length
  let i = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0
  let line = 1
  let lineStart = 0

  const pos = (): SourcePos => ({ line, column: i - lineStart })
  const fail = (message: string, at: SourcePos = pos()): never => {
    throw Object.assign(new SyntaxError(message), { lineNumber: at.line, column: at.column + 1 })
  }

  const skipWs = (): void => {
    while (i < len) {
      const code = text.charCodeAt(i)
      if (code === 0x20 || code === 0x09) {
        i++
      } else if (code === 0x0a) {
        i++
        line++
        lineStart = i
      } else if (code === 0x0d) {
        i++
        if (text.charCodeAt(i) === 0x0a) i++
        line++
        lineStart = i
      } else {
        break
      }
    }
  }

  const parseString = (): { readonly kind: "string"; readonly value: string; readonly loc: SourceLoc } => {
    const start = pos()
    i++
    let value = ""
    let chunkStart = i
    while (i < len) {
      const code = text.charCodeAt(i)
      if (code === 0x22) {
        value += text.slice(chunkStart, i)
        i++
        return { kind: "string", value, loc: { start, end: pos() } }
      }
      if (code < 0x20) fail("Unescaped control character in JSON string")
      if (code === 0x5c) {
        value += text.slice(chunkStart, i)
        const escAt = pos()
        i++
        if (i >= len) fail("Unterminated escape sequence in JSON string", escAt)
        const esc = text[i++]
        if (esc === '"' || esc === "\\" || esc === "/") value += esc
        else if (esc === "b") value += "\b"
        else if (esc === "f") value += "\f"
        else if (esc === "n") value += "\n"
        else if (esc === "r") value += "\r"
        else if (esc === "t") value += "\t"
        else if (esc === "u") {
          const hex = text.slice(i, i + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid Unicode escape in JSON string", escAt)
          value += String.fromCharCode(Number.parseInt(hex, 16))
          i += 4
        } else {
          fail(`Invalid escape sequence \\${esc} in JSON string`, escAt)
        }
        chunkStart = i
      } else {
        i++
      }
    }
    return fail("Unterminated JSON string", start)
  }

  const parseNumber = (): JsonNode => {
    const start = pos()
    const numStart = i
    if (text[i] === "-") i++
    if (text[i] === "0") {
      i++
      if (i < len && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) fail("Leading zero in JSON number", start)
    } else if (i < len && text.charCodeAt(i) >= 0x31 && text.charCodeAt(i) <= 0x39) {
      while (i < len && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++
    } else {
      fail("Invalid JSON number", start)
    }
    if (text[i] === ".") {
      i++
      const fracStart = i
      while (i < len && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++
      if (i === fracStart) fail("Expected digit after decimal point in JSON number", start)
    }
    if (text[i] === "e" || text[i] === "E") {
      i++
      if (text[i] === "+" || text[i] === "-") i++
      const expStart = i
      while (i < len && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++
      if (i === expStart) fail("Expected exponent digit in JSON number", start)
    }
    return { kind: "primitive", value: Number(text.slice(numStart, i)), loc: { start, end: pos() } }
  }

  const parseLiteral = (word: string, literalValue: boolean | null): JsonNode => {
    const start = pos()
    if (!text.startsWith(word, i)) fail(`Unexpected token in JSON`, start)
    i += word.length
    return { kind: "primitive", value: literalValue, loc: { start, end: pos() } }
  }

  const parseArray = (): JsonNode => {
    const start = pos()
    i++
    skipWs()
    const elements: JsonNode[] = []
    if (text[i] === "]") {
      i++
      return { kind: "array", elements, loc: { start, end: pos() } }
    }
    while (true) {
      elements.push(parseValue())
      skipWs()
      if (text[i] === ",") {
        i++
        skipWs()
        if (text[i] === "]") fail("Trailing comma in JSON array")
      } else if (text[i] === "]") {
        i++
        return { kind: "array", elements, loc: { start, end: pos() } }
      } else {
        fail("Expected ',' or ']' in JSON array")
      }
    }
  }

  const parseObject = (): JsonNode => {
    const start = pos()
    i++
    skipWs()
    const properties: JsonProperty[] = []
    if (text[i] === "}") {
      i++
      return { kind: "object", properties, loc: { start, end: pos() } }
    }
    while (true) {
      if (text[i] !== '"') fail("Expected double-quoted property name in JSON object")
      const keyNode = parseString()
      skipWs()
      if (text[i] !== ":") fail("Expected ':' after JSON property name")
      i++
      skipWs()
      const value = parseValue()
      properties.push({ key: keyNode.value, keyLoc: keyNode.loc, value })
      skipWs()
      if (text[i] === ",") {
        i++
        skipWs()
        if (text[i] === "}") fail("Trailing comma in JSON object")
      } else if (text[i] === "}") {
        i++
        return { kind: "object", properties, loc: { start, end: pos() } }
      } else {
        fail("Expected ',' or '}' in JSON object")
      }
    }
  }

  const parseValue = (): JsonNode => {
    if (i >= len) fail("Unexpected end of JSON input")
    const ch = text[i]
    if (ch === "{") return parseObject()
    if (ch === "[") return parseArray()
    if (ch === '"') return parseString()
    if (ch === "t") return parseLiteral("true", true)
    if (ch === "f") return parseLiteral("false", false)
    if (ch === "n") return parseLiteral("null", null)
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber()
    return fail(`Unexpected token ${JSON.stringify(ch)} in JSON`)
  }

  skipWs()
  const root = parseValue()
  skipWs()
  if (i < len) fail("Unexpected trailing token in JSON")
  return { root, end: pos() }
}

function parsePackageSpecifier(raw: string): { readonly pkg: PackageName; readonly subpath: Subpath | null } | null {
  const clean = raw.replace(/[?#].*$/, "")
  if (!clean || clean.startsWith(".") || clean.startsWith("/") || clean.startsWith("#") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(clean)) {
    return null
  }
  const parts = clean.split("/")
  if (clean.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null
    const pkg = `${parts[0]}/${parts[1]}` as PackageName
    if (parts.length === 2) return { pkg, subpath: null }
    return { pkg, subpath: `./${parts.slice(2).join("/")}` as Subpath }
  }
  const pkg = parts[0] as PackageName
  if (parts.length === 1) return { pkg, subpath: null }
  return { pkg, subpath: `./${parts.slice(1).join("/")}` as Subpath }
}

function normalizeRelPath(raw: string, label: string): RelPath {
  if (!raw || raw.includes("\\") || raw.startsWith("./") || raw.startsWith("/") || raw === "." || raw.split("/").includes("..")) {
    throw new Error(`withWorkspaceBarrels: ${label} key ${JSON.stringify(raw)} must be a normalized repo-relative POSIX path.`)
  }
  return raw as RelPath
}

function parseOptions(options: WorkspaceBarrelsOptions): { readonly root: string; readonly ratchet: NormalizedRatchet } {
  if (!options || typeof options.root !== "string" || !options.root.trim()) {
    throw new Error("withWorkspaceBarrels: options.root must be a non-empty workspace root path.")
  }
  const root = canonicalPath(options.root)

  const exportsMap = new Map<RelPath, ReadonlySet<Subpath>>()
  for (const [rawKey, rawList] of Object.entries(options.allowExports ?? {})) {
    const key = normalizeRelPath(rawKey, "allowExports")
    if (!key.endsWith("/package.json")) {
      throw new Error(`withWorkspaceBarrels: allowExports key ${JSON.stringify(rawKey)} must end with "/package.json".`)
    }
    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new Error(`withWorkspaceBarrels: allowExports[${JSON.stringify(rawKey)}] must be a non-empty array.`)
    }
    const entries = new Set<Subpath>()
    for (const item of rawList) {
      if (typeof item !== "string" || item === "." || !item.startsWith("./")) {
        throw new Error(`withWorkspaceBarrels: allowExports[${JSON.stringify(rawKey)}] entry ${JSON.stringify(item)} must start with "./" and never be ".".`)
      }
      entries.add(item as Subpath)
    }
    exportsMap.set(key, entries)
  }

  const importsMap = new Map<RelPath, ReadonlySet<SubpathSpecifier>>()
  for (const [rawKey, rawList] of Object.entries(options.allowImports ?? {})) {
    const key = normalizeRelPath(rawKey, "allowImports")
    if (!Array.isArray(rawList) || rawList.length === 0) {
      throw new Error(`withWorkspaceBarrels: allowImports[${JSON.stringify(rawKey)}] must be a non-empty array.`)
    }
    const entries = new Set<SubpathSpecifier>()
    for (const item of rawList) {
      const parsed = typeof item === "string" ? parsePackageSpecifier(item) : null
      if (!parsed || parsed.subpath === null) {
        throw new Error(`withWorkspaceBarrels: allowImports[${JSON.stringify(rawKey)}] entry ${JSON.stringify(item)} must be a package subpath specifier like "@scope/pkg/subpath".`)
      }
      entries.add(item.replace(/[?#].*$/, "") as SubpathSpecifier)
    }
    importsMap.set(key, entries)
  }

  return { root, ratchet: { exports: exportsMap, imports: importsMap } }
}

function scanYamlUnquoted(text: string, onChar: (ch: string, index: number) => boolean | void): void {
  let quote: "'" | '"' | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote === '"') {
      if (ch === "\\") i++
      else if (ch === '"') quote = undefined
    } else if (quote === "'") {
      if (ch === "'" && text[i + 1] === "'") i++
      else if (ch === "'") quote = undefined
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (onChar(ch, i) === true) {
      return
    }
  }
}

function stripYamlComment(line: string): string {
  let cut = line.length
  scanYamlUnquoted(line, (ch, i) => {
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      cut = i
      return true
    }
  })
  return line.slice(0, cut)
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2) {
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'")
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function splitYamlFlowItems(flowBody: string): string[] {
  const items: string[] = []
  let start = 0
  scanYamlUnquoted(flowBody, (ch, i) => {
    if (ch === ",") {
      const piece = unquoteYamlScalar(flowBody.slice(start, i))
      if (piece) items.push(piece)
      start = i + 1
    }
  })
  const tail = unquoteYamlScalar(flowBody.slice(start))
  if (tail) items.push(tail)
  return items
}

function parsePnpmWorkspacePackages(yamlText: string): string[] | undefined {
  const lines = yamlText.split(/\r?\n/)
  const patterns: string[] = []
  let inPackages = false
  let inFlow = false
  let flowBuffer = ""

  for (const rawLine of lines) {
    const line = stripYamlComment(rawLine)
    if (!inPackages) {
      const header = /^packages\s*:(.*)$/.exec(line)
      if (!header) continue
      inPackages = true
      const rest = header[1].trim()
      if (rest.startsWith("[")) {
        inFlow = true
        flowBuffer = rest
        const endIdx = flowBuffer.indexOf("]")
        if (endIdx >= 0) return splitYamlFlowItems(flowBuffer.slice(1, endIdx))
      }
      continue
    }

    if (inFlow) {
      flowBuffer += ` ${line.trim()}`
      const endIdx = flowBuffer.indexOf("]")
      if (endIdx >= 0) return splitYamlFlowItems(flowBuffer.slice(1, endIdx))
      continue
    }

    if (!line.trim()) continue
    if (/^\S/.test(line)) break
    const trimmed = line.trim()
    if (trimmed.startsWith("[")) {
      inFlow = true
      flowBuffer = trimmed
      const endIdx = flowBuffer.indexOf("]")
      if (endIdx >= 0) return splitYamlFlowItems(flowBuffer.slice(1, endIdx))
      continue
    }
    const itemMatch = /^-\s*(.+)$/.exec(trimmed)
    if (itemMatch) {
      const scalar = unquoteYamlScalar(itemMatch[1])
      if (scalar) patterns.push(scalar)
    }
  }

  return inPackages ? patterns : undefined
}

function normalizeWorkspacePatterns(rawPatterns: readonly string[]): WorkspaceGlobs {
  const include: string[] = []
  const exclude: string[] = []
  const seenInclude = new Set<string>()
  const seenExclude = new Set<string>()

  for (const raw of rawPatterns) {
    let body = raw.trim().replace(/\\/g, "/")
    const negated = body.startsWith("!")
    if (negated) body = body.slice(1).trim()
    while (body.startsWith("./")) body = body.slice(2)
    body = body.replace(/\/+$/, "")
    if (!body || body === ".") continue
    if (negated) {
      if (!seenExclude.has(body)) {
        seenExclude.add(body)
        exclude.push(body)
      }
    } else if (!seenInclude.has(body)) {
      seenInclude.add(body)
      include.push(body)
    }
  }
  return { include, exclude }
}

function parseWorkspaceGlobs(root: string): WorkspaceGlobs {
  const yamlPath = join(root, "pnpm-workspace.yaml")
  if (existsSync(yamlPath)) {
    const parsed = parsePnpmWorkspacePackages(readFileSync(yamlPath, "utf8"))
    if (parsed !== undefined) return normalizeWorkspacePatterns(parsed)
  }
  const rootPkgPath = join(root, "package.json")
  if (existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as { workspaces?: unknown }
      const raw = Array.isArray(rootPkg.workspaces)
        ? rootPkg.workspaces
        : rootPkg.workspaces && typeof rootPkg.workspaces === "object" && Array.isArray((rootPkg.workspaces as { packages?: unknown }).packages)
          ? (rootPkg.workspaces as { packages: unknown[] }).packages
          : []
      return normalizeWorkspacePatterns(raw.filter((item): item is string => typeof item === "string"))
    } catch {
      return { include: [], exclude: [] }
    }
  }
  return { include: [], exclude: [] }
}

function classifyExportsField(node: JsonNode | undefined): ExportsField {
  if (!node) return { kind: "absent" }
  if (node.kind === "string" || node.kind === "array") return { kind: "barrel", loc: node.loc }
  if (node.kind !== "object") return { kind: "invalid", loc: node.loc }
  if (node.properties.length === 0) return { kind: "subpath-map", loc: node.loc, entries: [] }
  const dotCount = node.properties.filter((p) => p.key.startsWith(".")).length
  if (dotCount === 0) return { kind: "barrel", loc: node.loc }
  if (dotCount !== node.properties.length) return { kind: "invalid", loc: node.loc }
  return { kind: "subpath-map", loc: node.loc, entries: node.properties }
}

interface TargetLeaves {
  readonly valid: boolean
  readonly runtimeTargets: readonly string[]
  readonly typeTargets: readonly string[]
  readonly hasNull: boolean
}

function collectCompositeLeaves(items: readonly { readonly value: JsonNode; readonly types: boolean }[]): TargetLeaves {
  if (items.length === 0) return { valid: false, runtimeTargets: [], typeTargets: [], hasNull: false }
  const runtimeTargets: string[] = []
  const typeTargets: string[] = []
  let valid = true
  let hasNull = false
  for (const item of items) {
    const sub = collectTargetLeaves(item.value, item.types)
    if (!sub.valid) valid = false
    runtimeTargets.push(...sub.runtimeTargets)
    typeTargets.push(...sub.typeTargets)
    if (sub.hasNull) hasNull = true
  }
  return { valid, runtimeTargets, typeTargets, hasNull }
}

function collectTargetLeaves(node: JsonNode, underTypes: boolean): TargetLeaves {
  if (node.kind === "string") {
    return underTypes
      ? { valid: true, runtimeTargets: [], typeTargets: [node.value], hasNull: false }
      : { valid: true, runtimeTargets: [node.value], typeTargets: [], hasNull: false }
  }
  if (node.kind === "primitive" && node.value === null) {
    return { valid: true, runtimeTargets: [], typeTargets: [], hasNull: true }
  }
  if (node.kind === "array") {
    return collectCompositeLeaves(node.elements.map((value) => ({ value, types: underTypes })))
  }
  if (node.kind === "object") {
    return collectCompositeLeaves(node.properties.map((prop) => ({ value: prop.value, types: underTypes || prop.key === "types" })))
  }
  return { valid: false, runtimeTargets: [], typeTargets: [], hasNull: false }
}

function classifySubpathEntry(prop: JsonProperty): SubpathVerdict {
  if (prop.key === ".") return { kind: "barrel" }
  const leaves = collectTargetLeaves(prop.value, false)
  if (leaves.valid && leaves.hasNull && leaves.runtimeTargets.length === 0 && leaves.typeTargets.length === 0) {
    return { kind: "blocked" }
  }
  if (prop.key.includes("*")) {
    return { kind: "forbidden", reason: "wildcard", loc: prop.keyLoc }
  }
  if (!hasExtension(prop.key, ASSET_EXTENSIONS)) {
    return { kind: "forbidden", reason: "code-subpath", loc: prop.keyLoc }
  }
  if (!leaves.valid || leaves.runtimeTargets.length === 0) {
    return { kind: "forbidden", reason: "non-asset-target", loc: prop.value.loc }
  }
  const runtimeOk = leaves.runtimeTargets.every((target) => hasExtension(target, ASSET_EXTENSIONS))
  const typesOk = leaves.typeTargets.every((target) => hasExtension(target, ASSET_EXTENSIONS) || hasExtension(target, TYPE_DECL_EXTENSIONS))
  if (!runtimeOk || !typesOk) {
    return { kind: "forbidden", reason: "non-asset-target", loc: prop.value.loc }
  }
  return { kind: "asset" }
}

function isVendoredToolchain(rootNode: JsonNode): boolean {
  if (rootNode.kind !== "object") return false
  let name: string | undefined
  let hasSpecBin = false
  for (const prop of rootNode.properties) {
    if (prop.key === "name" && prop.value.kind === "string") name = prop.value.value
    if (prop.key === "bin" && prop.value.kind === "object") {
      hasSpecBin = prop.value.properties.some((b) => b.key === "spec")
    }
  }
  return name === "vibestack" && hasSpecBin
}

function discoverWorkspace(root: string): WorkspaceIndex {
  const globs = parseWorkspaceGlobs(root)
  const manifestFiles = globs.include.map((pat) => `${pat}/package.json`)
  const manifestIgnores = ["package.json", ...globs.exclude.flatMap((pat) => [`${pat}/package.json`, `${pat}/**/package.json`])]
  const packages = new Map<PackageName, WorkspacePackage>()

  if (manifestFiles.length === 0) {
    return { root, manifestFiles, manifestIgnores, packages }
  }

  const found = globSync(manifestFiles, {
    cwd: root,
    exclude: [...DEFAULT_SCAN_EXCLUDES, ...manifestIgnores],
  }).map(toPosix).sort()

  for (const rel of found) {
    if (rel === "package.json") continue
    const dirRel = rel.slice(0, -"/package.json".length)
    if (globs.exclude.some((pat) => matchesGlob(dirRel, pat))) continue

    let doc: { readonly root: JsonNode }
    try {
      doc = parseJsonDocument(readFileSync(join(root, rel), "utf8"))
    } catch {
      continue
    }
    if (doc.root.kind !== "object") continue
    if (isVendoredToolchain(doc.root)) {
      manifestIgnores.push(rel)
      continue
    }

    let pkgName: PackageName | undefined
    let exportsNode: JsonNode | undefined
    for (const prop of doc.root.properties) {
      if (prop.key === "name" && prop.value.kind === "string" && prop.value.value) {
        pkgName = prop.value.value as PackageName
      } else if (prop.key === "exports") {
        exportsNode = prop.value
      }
    }
    if (!pkgName) continue

    const allowedAssets = new Set<Subpath>()
    const classified = classifyExportsField(exportsNode)
    if (classified.kind === "subpath-map") {
      for (const entry of classified.entries) {
        if (classifySubpathEntry(entry).kind === "asset") {
          allowedAssets.add(entry.key as Subpath)
        }
      }
    }
    packages.set(pkgName, {
      name: pkgName,
      manifestPath: rel as RelPath,
      allowedAssetSubpaths: allowedAssets,
    })
  }

  return { root, manifestFiles, manifestIgnores, packages }
}

function extractStaticString(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined
  const ast = node as AstNode
  if (ast.type === "Literal" && typeof ast.value === "string") return ast.value
  if (ast.type === "TemplateLiteral") {
    const expressions = ast.expressions as readonly unknown[] | undefined
    const quasis = ast.quasis as readonly { readonly value?: { readonly cooked?: string; readonly raw?: string } }[] | undefined
    if (expressions?.length === 0 && quasis?.length === 1) {
      return quasis[0].value?.cooked ?? quasis[0].value?.raw
    }
  }
  return undefined
}

function extractDynamicPrefix(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined
  const ast = node as AstNode
  if (ast.type === "TemplateLiteral") {
    const quasis = ast.quasis as readonly { readonly value?: { readonly cooked?: string; readonly raw?: string } }[] | undefined
    if (quasis && quasis.length > 0) return quasis[0].value?.cooked ?? quasis[0].value?.raw
  }
  if (ast.type === "BinaryExpression" && ast.operator === "+") {
    return extractStaticString(ast.left) ?? extractDynamicPrefix(ast.left)
  }
  return undefined
}

function memberPropName(node: AstNode): string | undefined {
  if (!node.computed) {
    const prop = node.property as AstNode | undefined
    return prop?.type === "Identifier" ? (prop.name as string) : undefined
  }
  return extractStaticString(node.property)
}

function isModuleCall(node: AstNode): boolean {
  if (node.optional) return false
  const callee = node.callee as AstNode | undefined
  if (!callee) return false
  if (callee.type === "Identifier" && callee.name === "require") return true
  if (callee.type !== "MemberExpression" || callee.optional) return false
  if (memberPropName(callee) !== "resolve") return false
  const obj = callee.object as AstNode | undefined
  if (!obj) return false
  if (obj.type === "Identifier" && obj.name === "require") return true
  if (obj.type === "MetaProperty") {
    const meta = obj.meta as { readonly name?: string } | undefined
    const prop = obj.property as { readonly name?: string } | undefined
    return meta?.name === "import" && prop?.name === "meta"
  }
  return false
}

function checkManifestExports(rootNode: JsonNode, allowed: ReadonlySet<Subpath> | undefined): { readonly loc: SourceLoc; readonly message: string }[] {
  const issues: { readonly loc: SourceLoc; readonly message: string }[] = []
  if (rootNode.kind !== "object") return issues

  const exportNodes: JsonNode[] = []
  let hasMainOrModule = false
  for (const prop of rootNode.properties) {
    if (prop.key === "exports") exportNodes.push(prop.value)
    else if (prop.key === "publishConfig" && prop.value.kind === "object") {
      for (const pubProp of prop.value.properties) {
        if (pubProp.key === "exports") exportNodes.push(pubProp.value)
      }
    } else if ((prop.key === "main" || prop.key === "module") && prop.value.kind === "string" && prop.value.value.trim().length > 0) {
      hasMainOrModule = true
    }
  }

  const usedAllowed = new Set<Subpath>()

  for (const exportNode of exportNodes) {
    const classified = classifyExportsField(exportNode)
    if (classified.kind === "invalid") {
      issues.push({ loc: classified.loc, message: 'Package "exports" must be a root entry string/conditions or a subpath map keyed from ".".' })
      continue
    }
    if (classified.kind !== "subpath-map") continue
    if (classified.entries.length === 0) {
      issues.push({ loc: classified.loc, message: 'Empty "exports" object: expose a root barrel "." or omit "exports".' })
      continue
    }

    let hasRootBarrel = false
    let hasAnyCodeSubpath = false
    for (const entry of classified.entries) {
      const verdict = classifySubpathEntry(entry)
      if (verdict.kind === "barrel") {
        hasRootBarrel = true
      } else if (verdict.kind === "forbidden") {
        hasAnyCodeSubpath = true
        if (allowed?.has(entry.key as Subpath)) {
          usedAllowed.add(entry.key as Subpath)
        } else {
          const hint = verdict.reason === "non-asset-target"
            ? `Non-barrel export "${entry.key}" points to a non-asset target; static asset exports must target an asset extension.`
            : verdict.reason === "wildcard"
              ? `Disallowed wildcard export "${entry.key}": export code only from the root barrel "." instead of wildcard subpaths.`
              : `Disallowed non-barrel export "${entry.key}": export code only from the root barrel "." (only explicit static assets like .css/.json may use subpaths).`
          issues.push({ loc: verdict.loc, message: hint })
        }
      }
    }

    if (!hasRootBarrel && !hasAnyCodeSubpath && hasMainOrModule) {
      issues.push({ loc: classified.loc, message: 'Package defines "main"/"module" alongside asset-only "exports" without a "." barrel export.' })
    }
  }

  for (const entry of allowed ?? []) {
    if (!usedAllowed.has(entry)) {
      issues.push({ loc: rootNode.loc, message: `Stale allowExports entry "${entry}" is no longer exported; remove it so the ratchet tightens.` })
    }
  }

  return issues
}

function createExportsRule(canonicalRoot: string, ratchet: ReadonlyMap<RelPath, ReadonlySet<Subpath>>) {
  return {
    meta: { type: "problem" as const, schema: [] },
    create(context: LintContext) {
      return {
        Program() {
          const manifest = context.sourceCode.parserServices?.manifest
          if (!manifest) return
          const rel = relativePosixPath(canonicalRoot, context.cwd, context.filename)
          const allowed = rel ? ratchet.get(rel) : undefined
          for (const problem of checkManifestExports(manifest, allowed)) {
            context.report({ loc: problem.loc, message: problem.message })
          }
        },
      }
    },
  }
}

function createNoSubpathImportsRule(index: WorkspaceIndex, ratchet: ReadonlyMap<RelPath, ReadonlySet<SubpathSpecifier>>) {
  return {
    meta: { type: "problem" as const, schema: [] },
    create(context: LintContext) {
      const rel = relativePosixPath(index.root, context.cwd, context.filename)
      const allowed = rel ? ratchet.get(rel) : undefined
      const usedAllowed = new Set<SubpathSpecifier>()

      const checkStatic = (node: AstNode, rawSpecifier: string): void => {
        const parsed = parsePackageSpecifier(rawSpecifier)
        if (!parsed || parsed.subpath === null) return
        const pkg = index.packages.get(parsed.pkg)
        if (!pkg) return
        if (pkg.allowedAssetSubpaths.has(parsed.subpath)) return

        const canonical = rawSpecifier.replace(/[?#].*$/, "") as SubpathSpecifier
        if (allowed?.has(canonical)) {
          usedAllowed.add(canonical)
          return
        }
        if (hasExtension(parsed.subpath, ASSET_EXTENSIONS)) {
          context.report({ node, message: `Import "${rawSpecifier}" is not a declared static asset export of "${parsed.pkg}".` })
          return
        }
        context.report({ node, message: `Import "${parsed.pkg}" from its root barrel instead of subpath "${rawSpecifier}".` })
      }

      const checkArgument = (argNode: unknown): void => {
        const staticSpec = extractStaticString(argNode)
        if (staticSpec !== undefined) {
          checkStatic(argNode as AstNode, staticSpec)
          return
        }
        const prefix = extractDynamicPrefix(argNode)
        if (!prefix) return
        const parsed = parsePackageSpecifier(`${prefix}x`)
        if (!parsed || parsed.subpath === null) return
        if (!prefix.startsWith(`${parsed.pkg}/`)) return
        if (index.packages.has(parsed.pkg)) {
          context.report({ node: argNode as AstNode, message: `Import "${parsed.pkg}" from its root barrel instead of a dynamic subpath "${prefix}...".` })
        }
      }

      const checkSource = (source: unknown): void => {
        const spec = extractStaticString(source)
        if (spec !== undefined) checkStatic(source as AstNode, spec)
      }

      return {
        ImportDeclaration: (node: AstNode) => checkSource(node.source),
        ExportNamedDeclaration: (node: AstNode) => { if (node.source) checkSource(node.source) },
        ExportAllDeclaration: (node: AstNode) => checkSource(node.source),
        ImportExpression: (node: AstNode) => checkArgument(node.source),
        CallExpression: (node: AstNode) => {
          const args = node.arguments as readonly unknown[] | undefined
          if (args && args.length > 0 && isModuleCall(node)) checkArgument(args[0])
        },
        TSExternalModuleReference: (node: AstNode) => checkSource(node.expression),
        TSImportType: (node: AstNode) => {
          const arg = node.argument as { readonly literal?: unknown } | undefined
          checkSource(node.source ?? arg?.literal ?? node.argument)
        },
        "Program:exit": (node: AstNode) => {
          for (const entry of allowed ?? []) {
            if (!usedAllowed.has(entry)) {
              context.report({ node, message: `Stale allowImports entry "${entry}" is no longer imported here; remove it so the ratchet tightens.` })
            }
          }
        },
      }
    },
  }
}

function createManifestParser(): EslintParser {
  const parser: EslintParser = {
    meta: { name: "vibestack/manifest-json", version: "1.0.0" },
    parseForESLint(text: string) {
      const { root, end } = parseJsonDocument(text)
      const loc: SourceLoc = { start: { line: 1, column: 0 }, end }
      return {
        ast: {
          type: "Program",
          body: [],
          sourceType: "module",
          range: [0, text.length],
          loc,
          tokens: [],
          comments: [],
        },
        services: {
          manifest: root,
          esTreeNodeToTSNodeMap: new WeakMap(),
          tsNodeToESTreeNodeMap: new WeakMap(),
        },
        scopeManager: null,
        visitorKeys: { Program: [] },
      }
    },
  }
  protectedParsers.add(parser)
  return parser
}

function findForbiddenInlineDisable(comments: readonly EslintComment[]): EslintComment | undefined {
  for (const comment of comments) {
    const trimmed = comment.value.trim()
    const disableMatch = /^eslint-disable(?:-next-line|-line)?(?:\s+([\s\S]*))?$/.exec(trimmed)
    if (disableMatch) {
      const rest = (disableMatch[1] ?? "").replace(/(?:^|\s+)--(?:[\s\S]*)$/, "").trim()
      if (!rest) return comment
      const rules = rest.split(/[\s,]+/).filter(Boolean)
      if (rules.length === 0 || rules.some((rule) => rule.startsWith("barrel/"))) return comment
      continue
    }
    if (/^eslint\s+[\s\S]*$/i.test(trimmed) && /(?:^|[\s,{])["']?barrel\//.test(trimmed)) {
      return comment
    }
  }
  return undefined
}

function guardBarrelDisable(parser: EslintParser): EslintParser {
  if (protectedParsers.has(parser)) return parser
  const existing = guardedParsers.get(parser)
  if (existing) return existing

  const wrapped: EslintParser = {
    meta: {
      name: `${parser.meta?.name ?? "parser"} with barrel/inline`,
      version: parser.meta?.version ?? "1.0.0",
    },
    parseForESLint(text: string, options?: unknown) {
      const parsed = parser.parseForESLint(text, options)
      const forbidden = findForbiddenInlineDisable(parsed.ast.comments ?? [])
      if (forbidden) {
        throw Object.assign(
          new SyntaxError("Inline eslint-disable cannot suppress barrel/* or omit rule names."),
          { lineNumber: forbidden.loc.start.line, column: forbidden.loc.start.column + 1 },
        )
      }
      return parsed
    },
  }
  guardedParsers.set(parser, wrapped)
  protectedParsers.add(wrapped)
  return wrapped
}

function isGlobalIgnore(entry: FlatConfig): boolean {
  return Array.isArray(entry.ignores) && Object.keys(entry).every((key) => GLOBAL_IGNORE_KEYS.has(key))
}

function targetsPackageJson(files: unknown): boolean {
  if (typeof files === "string") return files.includes("package.json")
  if (Array.isArray(files)) return files.some((item) => targetsPackageJson(item))
  return false
}

function isEslintParser(value: unknown): value is EslintParser {
  return typeof value === "object" && value !== null && "parseForESLint" in value && typeof value.parseForESLint === "function"
}

/**
 * Wraps an ESLint flat config to enforce barrel-only workspace exports (`barrel/exports` on workspace
 * `package.json` manifests) and barrel-only workspace imports (`barrel/no-subpath-imports` on JS/TS/VibeLang),
 * isolating `package.json` from non-manifest rules and blocking inline `eslint-disable` bypasses.
 */
export function withWorkspaceBarrels<T extends FlatConfig = FlatConfig>(
  config: readonly T[],
  options: WorkspaceBarrelsOptions,
): T[] {
  const { root, ratchet } = parseOptions(options)
  const workspace = discoverWorkspace(root)
  const manifestParser = createManifestParser()
  const barrelPlugin = {
    rules: {
      exports: createExportsRule(workspace.root, ratchet.exports),
      "no-subpath-imports": createNoSubpathImportsRule(workspace, ratchet.imports),
    },
  }

  const transformed: T[] = config.map((entry) => {
    if (isGlobalIgnore(entry)) return entry
    const next: FlatConfig = { ...entry }
    if (!entry.language && !targetsPackageJson(entry.files)) {
      const prevIgnores = entry.ignores ?? []
      if (!prevIgnores.includes("**/package.json")) {
        next.ignores = [...prevIgnores, "**/package.json"]
      }
    }
    const parser = entry.languageOptions?.parser
    if (isEslintParser(parser)) {
      next.languageOptions = {
        ...entry.languageOptions,
        parser: guardBarrelDisable(parser),
      }
    }
    return next as T
  })

  const importsEntry = {
    name: "vibestack/barrel-imports",
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vibe,vibex}"],
    plugins: { barrel: barrelPlugin },
    rules: { "barrel/no-subpath-imports": "error" },
  } satisfies FlatConfig
  transformed.push(importsEntry as unknown as T)

  if (workspace.manifestFiles.length > 0) {
    const exportsEntry = {
      name: "vibestack/barrel-exports",
      files: [...workspace.manifestFiles],
      ignores: [...workspace.manifestIgnores],
      languageOptions: {
        parser: manifestParser,
        parserOptions: { projectService: false, project: false, program: null },
      },
      plugins: { barrel: barrelPlugin },
      rules: { "barrel/exports": "error" },
    } satisfies FlatConfig
    transformed.push(exportsEntry as unknown as T)
  }

  return transformed
}
