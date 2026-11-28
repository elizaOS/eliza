// spec/meetings/index.md, "Story: Join a meeting as a disclosed transcription guest"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import type { Driver, Options } from "../../gen/meetings.conformance.ts"
import type { MeetingCapture } from "../../gen/meetings.ts"
import {
  MeetingTransport,
  captureMeeting,
  finishMeeting,
  getMeetingTranscript,
  keepTranscriptSegment,
  type MeetingRequest,
} from "@elizaos/plugin-meetings"

interface Session {
  readonly runtime: ManagedRuntime.ManagedRuntime<KeyValueStore.KeyValueStore, never>
  state: MeetingCapture
  pendingJoinSession: string
}

const sessions = new Map<string, Session>()

function sessionOf(key: string): Session {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created: Session = {
    runtime: ManagedRuntime.make(KeyValueStore.layerMemory),
    state: {
      capturePhase: "NoMeeting",
      provider: "GoogleMeet",
      sessionKey: "",
      disclosed: false,
      transcript: [],
      nextSeq: 1,
    },
    pendingJoinSession: "",
  }
  sessions.set(key, created)
  return created
}

function makeTransportLayer(accepted: boolean, disclosed: boolean, saved: boolean) {
  return Layer.succeed(MeetingTransport, {
    waitForAdmission: () => Effect.succeed(accepted),
    disclose: () => Effect.succeed(disclosed),
    stop: () => Effect.void,
    saveTranscript: () =>
      saved
        ? Effect.void
        : Effect.fail({ _tag: "MeetingProviderFailure", sessionKey: "", operation: "saveTranscript", reason: "failed" } as never),
  })
}

export const driver: Driver<MeetingCapture> = {
  reset() {
    for (const session of sessions.values()) {
      void session.runtime.dispose()
    }
    sessions.clear()
  },
  async dispatch(key, event) {
    const session = sessionOf(key)
    const s = session.state
    switch (event.type) {
      case "requestJoin": {
        if (s.capturePhase !== "NoMeeting" || event.sessionKey === "") return "refused"
        session.state = {
          ...s,
          capturePhase: "AwaitingAdmission",
          sessionKey: event.sessionKey,
          provider: event.provider,
        }
        session.pendingJoinSession = event.sessionKey
        return "accepted"
      }
      case "observeJoin": {
        if (s.capturePhase !== "AwaitingAdmission" || s.sessionKey !== event.sessionKey) return "refused"
        if (!event.accepted) {
          const req: MeetingRequest = {
            ownerId: key,
            sessionKey: event.sessionKey,
            provider: s.provider,
            verifiedJoinUrl: "https://meet.google.com/abc-defg-hij",
          }
          const next = await session.runtime.runPromise(
            captureMeeting(req).pipe(Effect.provide(makeTransportLayer(false, false, true))),
          )
          session.state = next
          return "accepted"
        }
        session.state = { ...s, capturePhase: "Admitted" }
        return "accepted"
      }
      case "observeDisclosure": {
        if (s.capturePhase !== "Admitted" || s.sessionKey !== event.sessionKey) return "refused"
        const req: MeetingRequest = {
          ownerId: key,
          sessionKey: event.sessionKey,
          provider: s.provider,
          verifiedJoinUrl: "https://meet.google.com/abc-defg-hij",
        }
        const next = await session.runtime.runPromise(
          captureMeeting(req).pipe(Effect.provide(makeTransportLayer(true, event.disclosed, true))),
        )
        session.state = next
        return "accepted"
      }
      case "appendSegment": {
        if (s.capturePhase !== "Capturing" || s.sessionKey !== event.sessionKey) return "refused"
        const res = await session.runtime.runPromiseExit(
          keepTranscriptSegment(key, event.sessionKey, event.segment),
        )
        if (res._tag === "Failure") return "refused"
        session.state = res.value
        return "accepted"
      }
      case "stopCapture": {
        if (s.capturePhase !== "Capturing" || s.sessionKey !== event.sessionKey) return "refused"
        session.state = { ...s, capturePhase: "Finalizing" }
        return "accepted"
      }
      case "finishTranscript": {
        if (s.capturePhase !== "Finalizing" || s.sessionKey !== event.sessionKey) return "refused"
        if (!event.saved) {
          session.state = { ...s, capturePhase: "FailedMeeting" }
          return "accepted"
        }
        const req: MeetingRequest = {
          ownerId: key,
          sessionKey: event.sessionKey,
          provider: s.provider,
          verifiedJoinUrl: "https://meet.google.com/abc-defg-hij",
        }
        const finished = await session.runtime.runPromise(
          finishMeeting(req).pipe(Effect.provide(makeTransportLayer(true, true, true))),
        )
        const transcript = await session.runtime.runPromise(getMeetingTranscript(key, event.sessionKey))
        session.state = { ...finished, transcript: [...transcript] }
        return "accepted"
      }
      default: {
        const unreachable: never = event
        return unreachable
      }
    }
  },
  observe(key): MeetingCapture {
    return sessionOf(key).state
  },
}

export const options: Options<MeetingCapture> = { keys: ["owner-1"] }
