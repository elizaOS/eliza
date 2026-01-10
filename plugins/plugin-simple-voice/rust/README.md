# Eliza Plugin Simple Voice (Rust)

Rust implementation of the SAM Text-to-Speech plugin.

## Installation

```bash
cargo build --release
```

## Usage

```rust
use eliza_plugin_simple_voice::{SamTTSService, SamTTSOptions};

let service = SamTTSService::default();
let audio = service.generate_audio("Hello", Some(SamTTSOptions::default()));
let wav = service.create_wav_buffer(&audio, 22050);
```

## Testing

```bash
cargo test
```
