// biome-ignore-all lint/correctness/noUndeclaredVariables: AudioWorklet globals are supplied by the worklet scope.

class ElizaVoiceSessionDownlink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.hadAudio = false;
    this.queuedSamples = 0;
    this.lastSequence = 0;
    this.handoffQueue = [];
    this.handoffReadOffset = 0;
    this.crossfadeSamples = 0;
    this.crossfadePosition = 0;
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
        this.handoffQueue = [];
        this.handoffReadOffset = 0;
        this.port.postMessage({
          type: "queue-depth",
          queuedSamples: 0,
          sequence: this.lastSequence,
        });
      } else if (data.type === "handoff") {
        this.lastSequence = Number(data.sequence) || this.lastSequence;
        this.handoffQueue = this.queue;
        this.handoffReadOffset = this.readOffset;
        this.queue = [];
        this.readOffset = 0;
        this.crossfadeSamples = Math.max(1, Number(data.crossfadeSamples) || 1);
        this.crossfadePosition = 0;
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
      while (
        this.handoffQueue.length > 0 &&
        this.handoffReadOffset >= this.handoffQueue[0].length
      ) {
        this.handoffQueue.shift();
        this.handoffReadOffset = 0;
      }
      const nextSample = this.queue.length > 0
        ? this.queue[0][this.readOffset]
        : null;
      const oldSample = this.handoffQueue.length > 0
        ? this.handoffQueue[0][this.handoffReadOffset]
        : null;
      if (nextSample !== null && oldSample !== null) {
        const progress = Math.min(1, this.crossfadePosition / this.crossfadeSamples);
        firstChannel[i] = oldSample * (1 - progress) + nextSample * progress;
        this.readOffset += 1;
        this.handoffReadOffset += 1;
        this.crossfadePosition += 1;
        this.queuedSamples = Math.max(0, this.queuedSamples - 1);
        if (this.crossfadePosition >= this.crossfadeSamples) {
          this.handoffQueue = [];
          this.handoffReadOffset = 0;
          this.port.postMessage({
            type: "handoff-completed",
            sequence: this.lastSequence,
          });
        }
      } else if (nextSample !== null) {
        firstChannel[i] = nextSample;
        this.readOffset += 1;
        this.queuedSamples = Math.max(0, this.queuedSamples - 1);
      } else if (oldSample !== null) {
        firstChannel[i] = oldSample;
        this.handoffReadOffset += 1;
      } else {
        firstChannel[i] = 0;
        if (this.handoffQueue.length === 0 && this.hadAudio) {
          this.hadAudio = false;
          this.port.postMessage({
            type: "drained",
            sequence: this.lastSequence,
          });
        }
      }
    }
    for (let channelIndex = 1; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].set(firstChannel);
    }
    return true;
  }
}

registerProcessor("eliza-voice-session-downlink", ElizaVoiceSessionDownlink);
