// spec/sql/connectionLifecycle.md, "Adapter lifecycle transitions preserve transaction, RLS, schema, and embedding invariants"
import type { Driver } from "../../gen/sql__connectionLifecycle.conformance.ts"
import type { ConnectionState, Event } from "../../gen/sql__connectionLifecycle.ts"
import { SqlConnectionLifecycleController } from "../../src/index.vibe"

const controllers = new Map<string, SqlConnectionLifecycleController>()

function controllerFor(key: string): SqlConnectionLifecycleController {
  let controller = controllers.get(key)
  if (!controller) {
    controller = new SqlConnectionLifecycleController()
    controllers.set(key, controller)
  }
  return controller
}

export const driver: Driver<ConnectionState> = {
  reset() {
    controllers.clear()
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const controller = controllerFor(key)
    let ok = false
    if (event.type === "beginConnect") {
      ok = controller.beginConnect(event.backend)
    } else if (event.type === "completeConnect") {
      ok = controller.completeConnect(event.schemaVersion)
    } else if (event.type === "failConnect") {
      ok = controller.failConnect()
    } else if (event.type === "beginTransaction") {
      ok = controller.beginTransaction(event.withEntityScope)
    } else if (event.type === "endTransaction") {
      ok = controller.endTransaction()
    } else if (event.type === "pinEmbeddingSpace") {
      ok = controller.pinEmbeddingSpace(event.dim)
    } else if (event.type === "beginShutdown") {
      ok = controller.beginShutdown()
    } else if (event.type === "finishClose") {
      ok = controller.finishClose()
    }
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<ConnectionState> {
    return Promise.resolve(controllerFor(key).getState())
  },
}

export const options = { keys: ["sql-a", "sql-b"] }
