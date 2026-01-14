export class LipSyncPlayer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private timeDomainData: Float32Array<ArrayBuffer> | null = null;

  private ensureContext(): AudioContext {
    if (this.audioContext) return this.audioContext;
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    this.audioContext = ctx;
    this.analyser = analyser;
    // Ensure plain ArrayBuffer backing.
    const buf = new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT);
    this.timeDomainData = new Float32Array(buf) as Float32Array<ArrayBuffer>;
    return ctx;
  }

  stop(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // ignore
      }
      try {
        this.source.disconnect();
      } catch {
        // ignore
      }
      this.source = null;
    }
  }

  async playWav(wav: ArrayBuffer): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // ignore
      }
    }

    this.stop();

    const audioBuffer = await ctx.decodeAudioData(wav.slice(0));
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;

    const analyser = this.analyser ?? ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    this.analyser = analyser;

    src.connect(analyser);
    analyser.connect(ctx.destination);
    this.source = src;

    return await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
  }

  getVolume(): number {
    const analyser = this.analyser;
    const data = this.timeDomainData;
    if (!analyser || !data) return 0;

    analyser.getFloatTimeDomainData(data as Float32Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    const cooked = 1 / (1 + Math.exp(-(rms * 30 - 2)));
    return Math.max(0, Math.min(1, cooked));
  }
}

