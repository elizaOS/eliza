# Architecture Notes — Audio Player Core v2.0

**Date:** 2024-04-22  
**Participants:** @jmiller, @schen, @akovacs, @rthompson  
**Status:** Approved

## Overview

The audio player core uses an **actor-based concurrency model** built on top of
`tokio`. Each major subsystem is encapsulated as an independent actor that
communicates via message passing. This design provides clear ownership boundaries,
eliminates shared mutable state (where possible), and makes the system testable
in isolation.

## Actor Topology

```
                    ┌──────────────┐
                    │  User/UI     │
                    └──────┬───────┘
                           │ commands (async)
                    ┌──────▼───────┐
                    │  QueueActor  │
                    └──┬───────┬───┘
                       │       │
            ┌──────────▼──┐  ┌─▼────────────┐
            │PlaybackActor│  │  StateActor   │
            └──────┬──────┘  └───────────────┘
                   │
            ┌──────▼──────┐
            │  CacheActor │
            └─────────────┘
```

### QueueActor

- Owns the `Vec<Track>` queue and the current position index.
- Handles add, remove, reorder, clear operations.
- Delegates persistence to SQLite via `rusqlite` (async wrapper).
- Notifies `PlaybackActor` when the current track changes.
- Notifies `StateActor` on every mutation for periodic persistence.

### PlaybackActor

- Manages the decode pipeline and audio output stream.
- Spawns a **dedicated decode thread** (not a tokio task) for real-time audio
  decoding using `symphonia`.
- The decode thread is set to **real-time priority** via platform-specific APIs
  (`sched_setscheduler` on Linux, `thread_policy_set` on macOS, etc.).
- **Critical constraint:** The audio decode thread **must not allocate** during
  steady-state playback. All buffers are pre-allocated at stream initialization.
- Uses a **lock-free ring buffer** (`ringbuf::HeapRb`) to pass decoded PCM
  samples from the decode thread to the audio output callback.
- Handles play, pause, stop, seek, speed changes.
- Speed adjustment is done via a high-quality resampler (`rubato` crate).

### CacheActor

- Runs on the tokio async runtime for I/O-bound cache operations.
- Implements LRU eviction with a max size of 512 MB (configurable).
- Prefetches the next N tracks (default: 3) when the current track reaches 75%
  completion.
- Cache entries are stored as decoded PCM in a memory-mapped file to avoid
  re-decoding on cache hits.
- Uses `blake3` for content-addressable cache keys.

### StateActor

- Persists player state to `sled` embedded database.
- Receives state snapshots from other actors.
- Writes are batched and flushed on a configurable interval (default: 30s).
- On startup, loads the last saved state and sends restoration messages to
  other actors.

## Inter-Actor Communication

| Channel | Type | Crate | Notes |
|---------|------|-------|-------|
| UI → QueueActor | `tokio::sync::mpsc` | tokio | Async, bounded (1024) |
| QueueActor → PlaybackActor | `tokio::sync::mpsc` | tokio | Async, bounded (64) |
| QueueActor → StateActor | `tokio::sync::mpsc` | tokio | Async, bounded (256) |
| PlaybackActor → CacheActor | `tokio::sync::mpsc` | tokio | Async, bounded (32) |
| PlaybackActor → DecodeThread | `crossbeam::channel` | crossbeam | **Sync**, bounded (8) |
| DecodeThread → AudioCallback | `ringbuf::HeapRb` | ringbuf | Lock-free SPSC ring buffer |

**Why crossbeam for the decode thread?** The decode thread is a real OS thread
(not a tokio task) because it needs real-time scheduling priority. Tokio channels
require an async runtime context, so we use `crossbeam::channel` for the
synchronous boundary between the async world and the real-time audio world.

## Platform Backend Abstraction

All platform-specific audio backends are abstracted behind a trait:

```rust
pub trait AudioBackend: Send + 'static {
    fn open_stream(&mut self, config: StreamConfig) -> Result<AudioStream, BackendError>;
    fn close_stream(&mut self) -> Result<(), BackendError>;
    fn supported_configs(&self) -> Vec<StreamConfig>;
    fn name(&self) -> &str;
}
```

Implementations:
- `CpalBackend` — covers Linux (PulseAudio, ALSA, PipeWire), macOS (CoreAudio),
  Windows (WASAPI, DirectSound) via the `cpal` crate (v0.15+).
- `OboeBackend` — Android via `oboe-rs`.

Backend selection is done at runtime based on platform detection and user
preference, with automatic fallback.

## Audio Pipeline

```
[Source File] → [Symphonia Decoder] → [Resampler (if needed)] → [Speed Adjust]
    → [Ring Buffer] → [Audio Output Callback] → [Hardware]
```

- The ring buffer capacity is set to 3x the audio callback buffer size to
  absorb scheduling jitter.
- If the ring buffer runs dry (underrun), silence is output and a warning is
  logged. The system does NOT block the audio callback.

## Memory Budget

| Component | Allocation | Notes |
|-----------|-----------|-------|
| Ring buffer | ~1 MB | 4096 frames × 2 channels × 4 bytes × 32 buffers |
| Decode buffer | ~2 MB | Pre-allocated decode workspace |
| Cache | 512 MB max | LRU eviction, configurable |
| Queue metadata | ~10 MB max | 10,000 tracks × ~1 KB each |
| State DB (sled) | ~5 MB | Compact binary format |

## Open Questions

1. Should we support JACK on Linux as an additional backend?
2. Do we need a separate thread for the resampler, or can it run in the decode
   thread without impacting real-time guarantees?
3. What's the right ring buffer size for Android where callback intervals are
   less predictable?

---

*These notes supersede all previous architecture documents. See `specs/requirements.yaml`
for the authoritative requirements specification.*
