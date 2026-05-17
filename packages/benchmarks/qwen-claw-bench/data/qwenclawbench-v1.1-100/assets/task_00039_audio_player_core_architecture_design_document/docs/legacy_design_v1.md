# Audio Player Core Design v1.0

**Author:** James Miller  
**Date:** 2022-03-10  
**Version:** 1.0

## 1. Introduction

This document describes the design of the audio player core library. The library
provides basic audio playback functionality for desktop applications. The initial
target platform is Linux, with potential future expansion to other operating
systems.

## 2. Architecture Overview

The audio player core follows a **single-threaded design** for simplicity and
ease of debugging. All operations — queue management, playback control, and
audio decoding — run on the main thread.

### 2.1 Main Loop

The main playback loop uses `std::thread::sleep` for timing control:

```rust
loop {
    if is_playing {
        let samples = decoder.decode_next_frame();
        output.write(samples);
        std::thread::sleep(Duration::from_millis(10));
    } else {
        std::thread::sleep(Duration::from_millis(50));
    }
}
```

This approach avoids the complexity of async runtimes and multi-threading while
providing acceptable playback quality for most use cases.

### 2.2 Global State

Player state is managed through global mutable variables using `lazy_static`:

```rust
lazy_static! {
    static ref PLAYER_STATE: Mutex<PlayerState> = Mutex::new(PlayerState::default());
    static ref CURRENT_QUEUE: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static ref PLAYBACK_POSITION: Mutex<u64> = Mutex::new(0);
}
```

This provides easy access to state from any function without passing references
through the call stack.

### 2.3 Queue Management

The playback queue is implemented as a simple `Vec<String>` containing file paths.
Operations:

- **Add:** `queue.push(path)` — always appends to the end
- **Remove:** `queue.remove(index)` — removes by index
- **Clear:** `queue.clear()`

No persistence layer is implemented. The queue is lost when the application exits.
Users are expected to reload their playlist on startup.

## 3. Codec Support

The initial release supports **MP3 only** via the `rodio` crate. MP3 was chosen
as it is the most widely used audio format and provides the best compatibility.

Future codec support (FLAC, OGG, WAV) may be added in later versions if there
is sufficient demand.

## 4. Dependencies

### 4.1 Recommended Crate Versions

| Crate | Version | Purpose |
|-------|---------|---------|
| `rodio` | `0.14` | Audio playback and MP3 decoding |
| `lazy_static` | `1.4` | Global state management |
| `hound` | `3.4` | WAV file reading (future) |

`rodio 0.14` is the recommended version as it has been thoroughly tested with
this design. It provides built-in MP3 decoding through the `minimp3` backend.

### 4.2 Cargo.toml

```toml
[dependencies]
rodio = "0.14"
lazy_static = "1.4"
```

## 5. Playback Controls

The following controls are supported:

- **Play:** Start playback from current position
- **Pause:** Pause playback (implemented by setting `is_playing = false`)
- **Stop:** Stop playback and reset position to 0
- **Next:** Advance to next track in queue
- **Previous:** Go back to previous track

Speed control and seek functionality are not supported in this version due to
the complexity of implementing them with the `rodio 0.14` API.

## 6. Play Modes

Only **sequential** playback is supported. The player plays tracks in order and
stops after the last track.

Shuffle and repeat modes are planned for a future release.

## 7. Error Handling

Errors are handled via `println!` to stderr and graceful degradation:

```rust
match decoder.decode() {
    Ok(samples) => output.write(samples),
    Err(e) => {
        eprintln!("Decode error: {}", e);
        skip_to_next();
    }
}
```

No structured error types are defined. All errors are treated as strings.

## 8. Threading Model

The application is entirely single-threaded. No `tokio`, `async-std`, or
`std::thread::spawn` calls are used. This eliminates an entire class of
concurrency bugs and makes the code straightforward to reason about.

If performance becomes an issue, a future version could explore moving audio
decoding to a separate thread, but this is not anticipated to be necessary for
the initial release.

## 9. Caching

No caching layer is implemented. Tracks are decoded from disk on every playback.
Modern SSDs provide sufficient read performance that caching is unnecessary for
local files.

## 10. Platform Support

Linux only (tested on Ubuntu 20.04 with PulseAudio). The `rodio` crate handles
the audio backend abstraction, so other platforms may work but are not officially
supported or tested.

## 11. Known Limitations

- Single-threaded design may cause UI freezes during track loading
- No gapless playback
- MP3 only
- No state persistence
- No shuffle or repeat modes
- No seek functionality
- No speed control
- Queue is lost on application exit

These limitations are acceptable for the v1.0 release and will be addressed in
subsequent versions based on user feedback and priority.
