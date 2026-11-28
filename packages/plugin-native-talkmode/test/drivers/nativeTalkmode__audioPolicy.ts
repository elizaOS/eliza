// spec/nativeTalkmode/audioPolicy.md, "Output mute and volume zero change audibility without stopping capture or active TTS progress"
import type { Driver } from "../../gen/nativeTalkmode__audioPolicy.conformance.ts"
import type { Event, TalkAudioPolicyState } from "../../gen/nativeTalkmode__audioPolicy.ts"
import { createTalkAudioPolicyHandle, type TalkAudioPolicyMachineHandle } from "../../src/index.vibe"

const handles = new Map<string, TalkAudioPolicyMachineHandle>()

function forKey(key: string): TalkAudioPolicyMachineHandle {
  const existing = handles.get(key)
  if (existing) return existing
  const created = createTalkAudioPolicyHandle()
  handles.set(key, created)
  return created
}

export const driver: Driver<TalkAudioPolicyState> = {
  reset() {
    handles.clear()
  },
  dispatch(key: string, event: Event) {
    return forKey(key).dispatch(event)
  },
  observe(key: string): TalkAudioPolicyState {
    return forKey(key).state()
  },
  receive(key: string, raw: unknown) {
    return forKey(key).receive(raw)
  },
}

export const options = { keys: ["a", "b"] }
