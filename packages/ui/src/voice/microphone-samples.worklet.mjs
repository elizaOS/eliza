// Mono samples only; unmodified outputs stay silent (no microphone monitoring).
const { AudioWorkletProcessor, registerProcessor } = globalThis;
class MicrophoneSamples extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel)
      for (const sample of channel) {
        this.buffer[this.offset++] = sample;
        if (this.offset === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(2048);
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor("eliza-microphone-samples", MicrophoneSamples);
