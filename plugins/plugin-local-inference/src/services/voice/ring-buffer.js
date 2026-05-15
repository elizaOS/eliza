export class PcmRingBuffer {
    capacity;
    sampleRate;
    sink;
    buf;
    readPos = 0;
    writePos = 0;
    filled = 0;
    onOverflow;
    constructor(capacity, sampleRate, sink, options = {}) {
        this.capacity = capacity;
        this.sampleRate = sampleRate;
        this.sink = sink;
        if (capacity <= 0) {
            throw new Error("PcmRingBuffer: capacity must be positive");
        }
        this.buf = new Float32Array(capacity);
        this.onOverflow = options.onOverflow;
    }
    write(pcm) {
        let dropped = 0;
        for (let i = 0; i < pcm.length; i++) {
            this.buf[this.writePos] = pcm[i];
            this.writePos = (this.writePos + 1) % this.capacity;
            if (this.filled < this.capacity) {
                this.filled++;
            }
            else {
                this.readPos = (this.readPos + 1) % this.capacity;
                dropped++;
            }
        }
        if (dropped > 0 && this.onOverflow) {
            this.onOverflow(dropped);
        }
    }
    /** Fill ratio in [0, 1]. Schedulers can throttle TTS dispatches as this approaches 1. */
    pressure() {
        return this.filled / this.capacity;
    }
    flushToSink() {
        if (this.filled === 0)
            return 0;
        const out = new Float32Array(this.filled);
        for (let i = 0; i < this.filled; i++) {
            out[i] = this.buf[(this.readPos + i) % this.capacity];
        }
        const n = this.filled;
        this.readPos = this.writePos;
        this.filled = 0;
        this.sink.write(out, this.sampleRate);
        return n;
    }
    drain() {
        this.readPos = this.writePos;
        this.filled = 0;
        this.sink.drain();
    }
    size() {
        return this.filled;
    }
    capacityHint() {
        return this.capacity;
    }
}
export class InMemoryAudioSink {
    chunks = [];
    buffered = 0;
    write(pcm, sampleRate) {
        this.chunks.push({ pcm, sampleRate });
        this.buffered += pcm.length;
    }
    drain() {
        this.buffered = 0;
    }
    bufferedSamples() {
        return this.buffered;
    }
    totalWritten() {
        let n = 0;
        for (const c of this.chunks)
            n += c.pcm.length;
        return n;
    }
}
//# sourceMappingURL=ring-buffer.js.map