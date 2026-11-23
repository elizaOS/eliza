// spec/agent/voice/clientAudio.md, "The capture keeps a bounded prefix in arrival order while the meter keeps counting"; spec/agent/voice/clientAudio.md, "A WAV holds every sample in order as mono PCM16 behind a 44-byte header"
import type { CaptureAudioPort, ClipAudioPort } from "./capture.vibe"

export const captureProcessorName = "eliza-capture-samples"

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

export const browserClipAudio: ClipAudioPort<AudioBuffer> = {
  decode: (bytes, sampleRate) => new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes),
  render: async (decoded, length, sampleRate) => {
    const renderer = new OfflineAudioContext(1, length, sampleRate)
    const source = renderer.createBufferSource()
    source.buffer = decoded
    source.connect(renderer.destination)
    source.start()
    return (await renderer.startRendering()).getChannelData(0)
  },
}
