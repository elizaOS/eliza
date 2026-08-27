// biome-ignore-all lint/correctness/noUndeclaredVariables: AudioWorklet globals are supplied by the worklet scope.

class ElizaVoiceSessionDownlink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.hadAudio = false;
    this.queuedSamples = 0;
    this.lastSequence = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "pcm" && data.pcm) {
        this.lastSequence = Number(data.sequence) || this.lastSequence;
        this.queue.push(data.pcm);
        this.queuedSamples += data.pcm.length;
        this.hadAudio = true;
        this.port.postMessage({
          type: "queue-depth",
          queuedSamples: this.queuedSamples,
          sequence: this.lastSequence,
        });
      } else if (data.type === "flush") {
        this.lastSequence = Number(data.sequence) || this.lastSequence;
        this.queue = [];
        this.readOffset = 0;
        this.queuedSamples = 0;
        this.hadAudio = false;
        this.port.postMessage({
          type: "queue-depth",
          queuedSamples: 0,
          sequence: this.lastSequence,
        });
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const firstChannel = output[0];
    if (!firstChannel) return true;
    for (let i = 0; i < firstChannel.length; i += 1) {
      while (
        this.queue.length > 0 &&
        this.readOffset >= this.queue[0].length
      ) {
        this.queue.shift();
        this.readOffset = 0;
      }
      if (this.queue.length === 0) {
        firstChannel[i] = 0;
        if (this.hadAudio) {
          this.hadAudio = false;
          this.port.postMessage({
            type: "drained",
            sequence: this.lastSequence,
          });
        }
      } else {
        firstChannel[i] = this.queue[0][this.readOffset];
        this.readOffset += 1;
        this.queuedSamples = Math.max(0, this.queuedSamples - 1);
      }
    }
    for (let channelIndex = 1; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].set(firstChannel);
    }
    return true;
  }
}

registerProcessor("eliza-voice-session-downlink", ElizaVoiceSessionDownlink);
