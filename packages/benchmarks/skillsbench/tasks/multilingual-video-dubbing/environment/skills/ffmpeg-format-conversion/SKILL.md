---
name: FFmpeg Format Conversion
description: Convert media files between formats - video containers, audio formats, and codec transcoding
---

# FFmpeg Format Conversion Skill

Convert media files between different formats and containers.

## When to Use

- Convert video containers (MP4, MKV, AVI, etc.)
- Convert audio formats (MP3, AAC, WAV, etc.)
- Transcode to different codecs
- Copy streams without re-encoding (fast)

## Basic Conversion

```bash
# Convert container format (re-encode)
ffmpeg -i input.avi output.mp4

# Copy streams without re-encoding (fast, no quality loss)
ffmpeg -i input.mp4 -c copy output.mkv

# Convert with specific codec
ffmpeg -i input.mp4 -c:v libx264 -c:a aac output.mp4
```

## Video Codec Conversion

```bash
# H.264
ffmpeg -i input.mp4 -c:v libx264 output.mp4

# H.265 (better compression)
ffmpeg -i input.mp4 -c:v libx265 output.mp4

# VP9 (web optimized)
ffmpeg -i input.mp4 -c:v libvpx-vp9 output.webm

# AV1 (modern codec)
ffmpeg -i input.mp4 -c:v libaom-av1 output.mp4
```

## Audio Format Conversion

```bash
# MP3
ffmpeg -i input.wav -acodec libmp3lame -q:a 2 output.mp3

# AAC
ffmpeg -i input.wav -c:a aac -b:a 192k output.m4a

# Opus (best quality/bitrate)
ffmpeg -i input.wav -c:a libopus -b:a 128k output.opus

# FLAC (lossless)
ffmpeg -i input.wav -c:a flac output.flac
```

## Quality Settings

```bash
# CRF (Constant Rate Factor) - lower is better quality
ffmpeg -i input.mp4 -c:v libx264 -crf 23 output.mp4

# Bitrate
ffmpeg -i input.mp4 -b:v 2M -b:a 192k output.mp4

# Two-pass encoding (best quality)
ffmpeg -i input.mp4 -c:v libx264 -b:v 2M -pass 1 -f null /dev/null
ffmpeg -i input.mp4 -c:v libx264 -b:v 2M -pass 2 output.mp4
```

## Presets

```bash
# Encoding speed presets (faster = larger file)
ffmpeg -i input.mp4 -c:v libx264 -preset fast output.mp4
# Options: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow

# Quality presets
ffmpeg -i input.mp4 -c:v libx264 -preset slow -crf 18 output.mp4
```

## Batch Conversion

```bash
# Convert all MKV to MP4
for f in *.mkv; do
  ffmpeg -i "$f" -c copy "${f%.mkv}.mp4"
done

# Convert with re-encoding
for f in *.avi; do
  ffmpeg -i "$f" -c:v libx264 -c:a aac "${f%.avi}.mp4"
done
```

## Common Codecs

### Video
- **H.264** (libx264) - Universal compatibility
- **H.265** (libx265) - Better compression
- **VP9** (libvpx-vp9) - Open standard
- **AV1** (libaom-av1) - Modern codec

### Audio
- **AAC** (aac) - Universal
- **MP3** (libmp3lame) - Legacy
- **Opus** (libopus) - Best quality/bitrate
- **FLAC** (flac) - Lossless

## Notes

- Use `-c copy` when possible for speed (no re-encoding)
- Re-encoding is slower but allows codec/quality changes
- CRF 18-23 is good quality range for H.264
- Preset affects encoding speed vs file size tradeoff
