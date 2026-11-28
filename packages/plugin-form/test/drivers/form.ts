// spec/form/index.md, "Story: Complete a form across several turns"
import { ManagedRuntime, type Effect } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import type { Driver, Options } from "../../gen/form.conformance.ts"
import type { Event, FormSession } from "../../gen/form.ts"
import { editForm, expireFormSession, readForm, startFormSession } from "../../src/index.vibe"

let runtime = ManagedRuntime.make(KeyValueStore.layerMemory)

function runWithStore<A, E>(eff: Effect.Effect<A, E, KeyValueStore.KeyValueStore>): Promise<A> {
  return runtime.runPromise(eff)
}

export const driver: Driver = {
  async reset() {
    await runtime.dispose()
    runtime = ManagedRuntime.make(KeyValueStore.layerMemory)
  },
  async dispatch(key: string, event: Event) {
    try {
      if (event.type === "startForm") {
        await runWithStore(
          startFormSession(
            { ownerId: event.ownerId, sessionId: key },
            {
              formId: event.formId,
              fields: event.visible,
              required: event.required,
              deadline: event.deadline,
            },
          ),
        )
        return "accepted"
      }
      if (event.type === "expireForm") {
        await runWithStore(expireFormSession({ ownerId: "person", sessionId: key }, event.at))
        return "accepted"
      }
      if (event.type === "recordAnswer") {
        await runWithStore(
          editForm(
            { ownerId: event.ownerId, sessionId: key },
            event.version,
            {
              type: "recordAnswer",
              question: event.question,
              answerText: event.answerText,
              confirmed: event.confirmed,
              visible: event.visible,
              required: event.required,
            },
            event.at,
          ),
        )
        return "accepted"
      }
      if (event.type === "confirmAnswer") {
        await runWithStore(
          editForm(
            { ownerId: event.ownerId, sessionId: key },
            event.version,
            { type: "confirmAnswer", question: event.question },
            event.at,
          ),
        )
        return "accepted"
      }
      await runWithStore(
        editForm({ ownerId: event.ownerId, sessionId: key }, event.version, { type: event.type }, event.at),
      )
      return "accepted"
    } catch {
      return "refused"
    }
  },
  observe(key: string): Promise<FormSession> {
    return runWithStore(readForm({ ownerId: "person", sessionId: key }))
  },
}

export const options: Options = { keys: ["a", "b"] }
