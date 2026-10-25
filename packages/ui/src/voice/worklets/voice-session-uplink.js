// biome-ignore-all lint/correctness/noUndeclaredVariables: AudioWorklet globals are supplied by the worklet scope.

class ElizaVoiceSessionUplink extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0] ? input[0].length : 0;
    if (frames === 0) return true;
    const channels = input.length;
    const mono = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
        const channel = input[channelIndex];
        sum += channel ? channel[i] || 0 : 0;
      }
      mono[i] = sum / channels;
    }
    this.port.postMessage({ pcm: mono, sampleRate }, [mono.buffer]);
    return true;
  }
}

registerProcessor("eliza-voice-session-uplink", ElizaVoiceSessionUplink);
