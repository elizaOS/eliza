// spec/agent/voice/clientAudio.md, "The capture keeps a bounded prefix in arrival order while the meter keeps counting"; spec/agent/voice/clientAudio.md, "A WAV holds every sample in order as mono PCM16 behind a 44-byte header"
import type { CaptureAudioPort } from "./capture.vibe"

const captureProcessorName = "eliza-capture-samples"

export const browserCaptureAudio: CaptureAudioPort<MediaStream, AudioContext> = {
  open: (sampleRate) => new AudioContext({ sampleRate }),
  samples: (context, receive) => {
    const node = new AudioWorkletNode(context, captureProcessorName, { channelCount: 1, channelCountMode: "explicit" })
    node.port.onmessage = (event: MessageEvent<unknown>) => receive(event.data)
    return {
      node,
      stop: () => {
        node.port.onmessage = null
        node.port.postMessage("stop")
        node.port.close()
      },
    }
  },
}
