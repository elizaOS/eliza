// spec/computerUse/index.md, "A command is scoped to one session generation, surface and authorized operation"
import { execFile, execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inflateSync } from "node:zlib"
import type { FileEntry, PlatformOS } from "./types.vibe"

export interface CommandRunResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface CommandBufferResult {
  readonly stdout: Uint8Array
  readonly stderr: string
  readonly exitCode: number
}

const commandExistsCache = new Map<string, boolean>()

export function currentPlatform(): PlatformOS {
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform
  }
  return "linux"
}

export function getEnvValue(name: string): string | undefined {
  return process.env[name]
}

export function getProcessEnvSnapshot(): Record<string, string | undefined> {
  return { ...process.env }
}

export function isWaylandSession(): boolean {
  if (currentPlatform() !== "linux") return false
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland"
}

export function isHeadfulGuiAvailable(): boolean {
  const platform = currentPlatform()
  if (platform === "darwin" || platform === "win32") return true
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

export function clearCommandExistsCache(): void {
  commandExistsCache.clear()
}

export function commandExists(command: string): boolean {
  if (!command || /[^A-Za-z0-9._-]/.test(command)) return false
  const cached = commandExistsCache.get(command)
  if (cached !== undefined) return cached
  const lookup = currentPlatform() === "win32" ? "where" : "which"
  try {
    execFileSync(lookup, [command], { stdio: "ignore", timeout: 3000 })
    commandExistsCache.set(command, true)
    return true
  } catch {
    commandExistsCache.set(command, false)
    return false
  }
}

export function runNativeCommandSync(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly env?: Record<string, string>; readonly input?: string } = {},
): CommandRunResult {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs ?? 10_000,
      env: options.env,
      input: options.input,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { stdout, stderr: "", exitCode: 0 }
  } catch (err: unknown) {
    const e = err as { readonly stdout?: unknown; readonly stderr?: unknown; readonly status?: unknown; readonly message?: unknown }
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : Buffer.isBuffer(e.stdout) ? e.stdout.toString("utf8") : "",
      stderr: typeof e.stderr === "string" ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : typeof e.message === "string" ? e.message : String(err),
      exitCode: typeof e.status === "number" ? e.status : 1,
    }
  }
}

export function runNativeCommand(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly env?: Record<string, string>; readonly cwd?: string; readonly input?: string } = {},
): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 10_000,
        env: options.env,
        cwd: options.cwd,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 })
          return
        }
        const code = typeof (err as { readonly code?: unknown }).code === "number"
          ? (err as { readonly code: number }).code
          : 1
        resolve({ stdout: stdout ?? "", stderr: stderr || err.message, exitCode: code })
      },
    )
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
  })
}

export function runNativeCommandBuffer(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly env?: Record<string, string> } = {},
): Promise<CommandBufferResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "buffer",
        timeout: options.timeoutMs ?? 10_000,
        env: options.env,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? new Uint8Array(stdout) : new Uint8Array()
        const errText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : ""
        if (!err) {
          resolve({ stdout: out, stderr: errText, exitCode: 0 })
          return
        }
        const code = typeof (err as { readonly code?: unknown }).code === "number"
          ? (err as { readonly code: number }).code
          : 1
        resolve({ stdout: out, stderr: errText || err.message, exitCode: code })
      },
    )
  })
}

export function spawnDetachedApp(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): number {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: "ignore",
    env,
  })
  child.unref()
  return child.pid ?? 0
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export function nextUniqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"))
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

export function inflateZlib(bytes: Uint8Array): Uint8Array | undefined {
  try {
    return new Uint8Array(inflateSync(bytes))
  } catch {
    return undefined
  }
}

export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function createDeferredPromise<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolveFn: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve
  })
  return { promise, resolve: resolveFn }
}

export function bigIntBit(index: number): bigint {
  return 1n << BigInt(index)
}

export function makeTempFilePath(prefix: string, ext: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomUUID()}${ext}`)
}

export async function readFileBytesAndRemove(filePath: string): Promise<Uint8Array> {
  try {
    const buf = await fsp.readFile(filePath)
    return new Uint8Array(buf)
  } finally {
    await fsp.rm(filePath, { force: true }).catch(() => undefined)
  }
}

export async function resolveCanonicalPath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath)
  try {
    return await fsp.realpath(resolved)
  } catch {
    const parent = path.dirname(resolved)
    const base = path.basename(resolved)
    try {
      const canonicalParent = await fsp.realpath(parent)
      return path.join(canonicalParent, base)
    } catch {
      return resolved
    }
  }
}

export async function readNativeFile(filePath: string, encoding: BufferEncoding = "utf8"): Promise<string> {
  return fsp.readFile(filePath, { encoding })
}

export async function writeNativeFile(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, content, "utf8")
}

export async function appendNativeFile(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.appendFile(filePath, content, "utf8")
}

export async function readNativeBytes(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const stat = await fsp.stat(filePath)
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds maximum allowed size (${stat.size} > ${maxBytes} bytes)`)
  }
  return new Uint8Array(await fsp.readFile(filePath))
}

export async function writeNativeBytes(filePath: string, bytes: Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, bytes)
}

export async function deleteNativeFile(filePath: string): Promise<void> {
  await fsp.unlink(filePath)
}

export async function createNativeDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true })
}

export async function deleteNativeDir(dirPath: string, recursive: boolean): Promise<void> {
  await fsp.rm(dirPath, { recursive, force: false })
}

export async function statNativePath(targetPath: string): Promise<{ readonly exists: boolean; readonly isDirectory: boolean; readonly size: number }> {
  try {
    const st = await fsp.stat(targetPath)
    return { exists: true, isDirectory: st.isDirectory(), size: st.size }
  } catch {
    return { exists: false, isDirectory: false, size: 0 }
  }
}

export async function listNativeDirectory(dirPath: string): Promise<FileEntry[]> {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true })
  const out: FileEntry[] = []
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    let size = 0
    if (!entry.isDirectory()) {
      try {
        const st = await fsp.stat(fullPath)
        size = st.size
      } catch {
        size = 0
      }
    }
    out.push({
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
      size,
    })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

export function findLocalBrowserExecutable(): string | undefined {
  const platform = currentPlatform()
  const candidates = platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Arc.app/Contents/MacOS/Arc",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/brave-browser",
        ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

export async function fetchJsonOverHttp(
  url: string,
  options: { readonly method?: string; readonly body?: string; readonly headers?: Record<string, string> } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  })
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

export async function sendCdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const id = 1
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        return fn()
      }
      fn()
    }
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method, params }))
    })
    ws.addEventListener("message", (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as { readonly id?: number; readonly result?: Record<string, unknown>; readonly error?: { readonly message?: string } }
        if (parsed.id !== id) return
        if (parsed.error) {
          finish(() => reject(new Error(parsed.error?.message ?? `CDP error in ${method}`)))
        } else {
          finish(() => resolve(parsed.result ?? {}))
        }
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    })
    ws.addEventListener("error", () => {
      finish(() => reject(new Error(`CDP WebSocket error for ${method}`)))
    })
  })
}
