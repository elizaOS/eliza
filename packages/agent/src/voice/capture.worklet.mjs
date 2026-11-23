// spec/agent/voice/clientAudio.md, "The capture keeps a bounded prefix in arrival order while the meter keeps counting"
const { AudioWorkletProcessor, registerProcessor } = globalThis
const blockSamples = 2048

class CaptureSamples extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(blockSamples)
    this.filled = 0
    this.stopped = false
    this.port.onmessage = () => { this.stopped = true }
  }

  /** @param {AudioWorkletInputs} inputs */
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (this.stopped) return false
    if (channel === undefined) return true
    for (const sample of channel) {
      this.block[this.filled++] = sample
      if (this.filled === blockSamples) {
        this.port.postMessage(this.block, [this.block.buffer])
        this.block = new Float32Array(blockSamples)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor("eliza-capture-samples", CaptureSamples)
