// biome-ignore-all lint/correctness/noUndeclaredVariables: AudioWorklet globals are supplied by the worklet scope.

class ElizaVoiceSessionDownlink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.hadAudio = false;
    this.paused = false;
    this.latestSequence = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "pcm" && data.pcm) {
        this.queue.push(data.pcm);
        this.hadAudio = true;
        if (Number.isSafeInteger(data.sequence)) {
          this.latestSequence = data.sequence;
        }
      } else if (data.type === "flush") {
        this.queue = [];
        this.readOffset = 0;
        this.hadAudio = false;
        this.paused = false;
        if (Number.isSafeInteger(data.sequence)) {
          this.latestSequence = data.sequence;
        }
      } else if (data.type === "pause") {
        this.paused = true;
      } else if (data.type === "resume") {
        this.paused = false;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const firstChannel = output[0];
    if (!firstChannel) return true;
    if (this.paused) {
      for (const channel of output) channel.fill(0);
      return true;
    }
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
            sequence: this.latestSequence,
          });
        }
      } else {
        firstChannel[i] = this.queue[0][this.readOffset];
        this.readOffset += 1;
      }
    }
    for (let channelIndex = 1; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].set(firstChannel);
    }
    return true;
  }
}

registerProcessor("eliza-voice-session-downlink", ElizaVoiceSessionDownlink);
