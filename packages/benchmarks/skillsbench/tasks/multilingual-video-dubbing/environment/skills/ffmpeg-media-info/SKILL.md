---
name: FFmpeg Media Info
description: Analyze media file properties - duration, resolution, bitrate, codecs, and stream information
---

# FFmpeg Media Info Skill

Extract and analyze media file metadata using ffprobe and ffmpeg.

## When to Use

- Get video/audio file properties
- Check codec information
- Verify resolution and bitrate
- Analyze stream details
- Debug media file issues

## Basic Info Commands

```bash
# Show all file info
ffmpeg -i input.mp4

# JSON format (detailed)
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4

# Simple format
ffprobe -v quiet -print_format json -show_format input.mp4
```

## Duration

```bash
# Get duration in seconds
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 input.mp4

# Duration with timestamp format
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 -sexagesimal input.mp4
```

## Resolution

```bash
# Get video resolution
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height \
  -of csv=s=x:p=0 input.mp4

# Get resolution as JSON
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height \
  -of json input.mp4
```

## Bitrate

```bash
# Get overall bitrate
ffprobe -v error -show_entries format=bit_rate \
  -of default=noprint_wrappers=1:nokey=1 input.mp4

# Get video bitrate
ffprobe -v error -select_streams v:0 \
  -show_entries stream=bit_rate \
  -of default=noprint_wrappers=1:nokey=1 input.mp4
```

## Codec Information

```bash
# Video codec
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,codec_long_name \
  -of default=noprint_wrappers=1 input.mp4

# Audio codec
ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,codec_long_name \
  -of default=noprint_wrappers=1 input.mp4
```

## Sample Rate and Channels

```bash
# Audio sample rate
ffprobe -v error -select_streams a:0 \
  -show_entries stream=sample_rate \
  -of default=noprint_wrappers=1:nokey=1 input.mp4

# Audio channels
ffprobe -v error -select_streams a:0 \
  -show_entries stream=channels \
  -of default=noprint_wrappers=1:nokey=1 input.mp4
```

## Stream Count

```bash
# Count video streams
ffprobe -v error -select_streams v -show_entries stream=index \
  -of csv=p=0 input.mp4 | wc -l

# Count audio streams
ffprobe -v error -select_streams a -show_entries stream=index \
  -of csv=p=0 input.mp4 | wc -l
```

## Frame Rate

```bash
# Get frame rate
ffprobe -v error -select_streams v:0 \
  -show_entries stream=r_frame_rate \
  -of default=noprint_wrappers=1:nokey=1 input.mp4
```

## Notes

- Use `-v error` to suppress warnings
- `-of json` for structured output
- `-select_streams` to target specific streams (v:0 for first video, a:0 for first audio)
