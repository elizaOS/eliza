// biome-ignore-all lint/correctness/noUndeclaredVariables: AudioWorklet globals are supplied by the worklet scope.

class ElizaPlaybackReferenceTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] || [];
    const firstChannel = input[0];
    if (firstChannel && firstChannel.length > 0) {
      const mono = new Float32Array(firstChannel.length);
      const channels = Math.max(1, input.length);
      for (let i = 0; i < firstChannel.length; i += 1) {
        let sum = 0;
        let count = 0;
        for (
          let channelIndex = 0;
          channelIndex < channels;
          channelIndex += 1
        ) {
          const channel = input[channelIndex];
          if (channel) {
            sum += channel[i] || 0;
            count += 1;
          }
        }
        mono[i] = count > 0 ? sum / count : 0;
      }
      this.port.postMessage({ pcm: mono, sampleRate }, [mono.buffer]);
    }
    return true;
  }
}

registerProcessor("eliza-playback-reference-tap", ElizaPlaybackReferenceTap);
