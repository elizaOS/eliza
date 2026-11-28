// spec/video/index.md, "Story: Transcribe a video and reuse only completed work"
import type { Driver } from "../../gen/video.conformance.ts"
import type { Event, VideoRun } from "../../gen/video.ts"
import { createVideoRunHandle, type VideoRunMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, VideoRunMachineHandle>()

function forKey(key: string): VideoRunMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createVideoRunHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<VideoRun> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): VideoRun {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
