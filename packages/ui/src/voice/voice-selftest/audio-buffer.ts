export function measureBufferLevel(buffer: AudioBuffer): {
  peak: number;
  rms: number;
} {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i] ?? 0);
      if (v > peak) peak = v;
      sumSquares += v * v;
      count += 1;
    }
  }
  return { peak, rms: count > 0 ? Math.sqrt(sumSquares / count) : 0 };
}
