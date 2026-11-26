// spec/pty/policy.md, "Story: Enforce session capacity, confinement, and safe teardown"
import type { Driver } from "../../gen/pty__policy.conformance.ts"
import type { Event, PtyPool } from "../../gen/pty__policy.ts"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { PtyConsoleBridge, PtySessionStore, type PtyHandle, type PtySpawn } from "../../src/index.vibe"

interface DriverPty extends PtyHandle {
  emitExit(code: number): void
  killError?: Error
}

function createDriverPty(): DriverPty {
  let exitListener: ((event: { exitCode: number }) => void) | undefined
  const handle: DriverPty = {
    pid: 1001,
    write() {},
    resize() {},
    kill() {
      if (handle.killError) throw handle.killError
      handle.emitExit(0)
    },
    onData() {
      return { dispose() {} }
    },
    onExit(listener) {
      exitListener = listener
      return {
        dispose() {
          exitListener = undefined
        },
      }
    },
    emitExit(code: number) {
      exitListener?.({ exitCode: code })
    },
  }
  return handle
}

interface PoolInstance {
  readonly store: PtySessionStore
  readonly handles: Map<string, DriverPty>
  readonly idMap: Map<string, string>
  readonly reverseIdMap: Map<string, string>
  readonly reapCallbacks: Map<string, () => void>
}

const instances = new Map<string, PoolInstance>()
const ALLOWED_ROOT = dirname(fileURLToPath(import.meta.url))
const OUTSIDE_ROOT = dirname(ALLOWED_ROOT)

function getOrCreate(key: string): PoolInstance {
  const existing = instances.get(key)
  if (existing) return existing
  const handles = new Map<string, DriverPty>()
  const reapCallbacks = new Map<string, () => void>()
  let lastCreated: DriverPty | undefined
  const spawn: PtySpawn = () => {
    const pty = createDriverPty()
    lastCreated = pty
    return pty
  }
  const bridge = new PtyConsoleBridge()
  const store = new PtySessionStore(
    bridge,
    () => Promise.resolve(spawn),
    { allowedRoot: ALLOWED_ROOT, maxSessions: 2, idleTimeoutMs: 0, exitedSessionTtlMs: 10_000 },
    (delayMs, run) => {
      if (delayMs === 10_000) {
        const exited = store.list().find((s) => s.exited && !reapCallbacks.has(s.sessionId))
        if (exited) reapCallbacks.set(exited.sessionId, run)
      }
      return { cancel() {} }
    },
  )
  const originalStart = store.start.bind(store)
  store.start = async (spec) => {
    const info = await originalStart(spec)
    if (lastCreated) handles.set(info.sessionId, lastCreated)
    return info
  }
  const instance: PoolInstance = {
    store,
    handles,
    idMap: new Map(),
    reverseIdMap: new Map(),
    reapCallbacks,
  }
  instances.set(key, instance)
  return instance
}

function projectState(instance: PoolInstance): PtyPool {
  const raw = instance.store.getPoolState()
  return {
    maxSessions: raw.maxSessions,
    nextEpoch: raw.nextEpoch,
    entries: raw.entries.map((entry) => ({
      sessionId: instance.reverseIdMap.get(entry.sessionId) ?? entry.sessionId,
      epoch: entry.epoch,
      status: entry.status,
    })),
  }
}

export const driver: Driver = {
  async reset() {
    for (const instance of instances.values()) {
      for (const h of instance.handles.values()) h.killError = undefined
      await instance.store.stopAll()
    }
    instances.clear()
  },
  async dispatch(key: string, event: Event) {
    const instance = getOrCreate(key)
    if (event.type === "startPoolSession") {
      if (event.sessionId === "" || instance.idMap.has(event.sessionId)) {
        return "refused"
      }
      try {
        const info = await instance.store.start({
          command: "sh",
          args: [],
          cwd: event.cwdConfined ? ALLOWED_ROOT : OUTSIDE_ROOT,
          kind: "test",
        })
        instance.idMap.set(event.sessionId, info.sessionId)
        instance.reverseIdMap.set(info.sessionId, event.sessionId)
        return "accepted"
      } catch {
        return "refused"
      }
    }
    if (event.type === "exitPoolSession") {
      const realId = instance.idMap.get(event.sessionId)
      if (!realId) return "refused"
      const current = instance.store.list().find((s) => s.sessionId === realId)
      if (!current || current.exited) return "refused"
      instance.handles.get(realId)?.emitExit(0)
      return "accepted"
    }
    if (event.type === "stopPoolSession") {
      const realId = instance.idMap.get(event.sessionId)
      if (!realId || !instance.store.has(realId)) return "refused"
      const handle = instance.handles.get(realId)
      if (handle) {
        handle.killError = event.killSucceeded ? undefined : new Error("EPERM")
      }
      try {
        await instance.store.stop(realId)
        instance.idMap.delete(event.sessionId)
        instance.reverseIdMap.delete(realId)
        instance.reapCallbacks.delete(realId)
        return "accepted"
      } catch {
        return "refused"
      }
    }
    if (event.type === "reapPoolSession") {
      const realId = instance.idMap.get(event.sessionId)
      if (!realId) return "refused"
      const reap = instance.reapCallbacks.get(realId)
      if (!reap) return "refused"
      reap()
      instance.idMap.delete(event.sessionId)
      instance.reverseIdMap.delete(realId)
      instance.reapCallbacks.delete(realId)
      return "accepted"
    }
    return "refused"
  },
  observe(key: string) {
    return Promise.resolve(projectState(getOrCreate(key)))
  },
}

export const options = { keys: ["pool-a", "pool-b"] }
