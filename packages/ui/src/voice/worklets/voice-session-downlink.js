// biome-ignore-all lint/correctness/noUndeclaredVariables: AudioWorklet globals are supplied by the worklet scope.

class ElizaVoiceSessionDownlink extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.hadAudio = false;
    this.paused = false;
    this.latestSequence = 0;
    this.playedSamples = 0;
    this.lastReportedPlayedSamples = 0;
    this.responseEpoch = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "pcm" && data.pcm) {
        this.queue.push({
          pcm: data.pcm,
          sequence: Number.isSafeInteger(data.sequence) ? data.sequence : null,
          started: false,
        });
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
      } else if (data.type === "begin_response") {
        this.playedSamples = 0;
        this.lastReportedPlayedSamples = 0;
        this.responseEpoch = Number.isSafeInteger(data.responseEpoch)
          ? data.responseEpoch
          : this.responseEpoch + 1;
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
        this.readOffset >= this.queue[0].pcm.length
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
        const frame = this.queue[0];
        if (!frame.started) {
          frame.started = true;
          if (Number.isSafeInteger(frame.sequence)) {
            this.port.postMessage({
              type: "started",
              sequence: frame.sequence,
            });
          }
        }
        firstChannel[i] = frame.pcm[this.readOffset];
        this.readOffset += 1;
        this.playedSamples += 1;
      }
    }
    for (let channelIndex = 1; channelIndex < output.length; channelIndex += 1) {
      output[channelIndex].set(firstChannel);
    }
    // Report every two 128-sample render quanta (about 5.3 ms at 48 kHz). The
    // main thread snapshots the latest monotonic clock synchronously on barge.
    if (this.playedSamples - this.lastReportedPlayedSamples >= 256) {
      this.lastReportedPlayedSamples = this.playedSamples;
      this.port.postMessage({
        type: "progress",
        playedSamples: this.playedSamples,
        responseEpoch: this.responseEpoch,
      });
    }
    return true;
  }
}

registerProcessor("eliza-voice-session-downlink", ElizaVoiceSessionDownlink);
