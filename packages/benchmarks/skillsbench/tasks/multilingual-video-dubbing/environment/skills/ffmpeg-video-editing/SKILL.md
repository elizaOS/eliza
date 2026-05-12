---
name: FFmpeg Video Editing
description: Cut, trim, concatenate, and split video files - basic video editing operations
---

# FFmpeg Video Editing Skill

Basic video editing operations: cutting, trimming, concatenating, and splitting videos.

## When to Use

- Cut segments from video
- Trim video length
- Concatenate multiple videos
- Split video into parts
- Extract specific time ranges

## Cutting and Trimming

```bash
# Cut from 10s to 30s (using -ss and -to)
ffmpeg -ss 00:00:10 -to 00:00:30 -i input.mp4 -c copy output.mp4

# Cut from 10s for 20 seconds duration
ffmpeg -ss 00:00:10 -t 20 -i input.mp4 -c copy output.mp4

# First 60 seconds
ffmpeg -t 60 -i input.mp4 -c copy output.mp4

# Last 30 seconds (need duration first)
ffmpeg -sseof -30 -i input.mp4 -c copy output.mp4
```

## Precise Cutting

```bash
# With re-encoding (more precise)
ffmpeg -ss 00:00:10 -i input.mp4 -t 20 -c:v libx264 -c:a aac output.mp4

# Keyframe-accurate (faster, may be less precise)
ffmpeg -ss 00:00:10 -i input.mp4 -t 20 -c copy output.mp4
```

## Concatenation

### Method 1: File List (Recommended)

```bash
# Create list.txt file:
# file 'video1.mp4'
# file 'video2.mp4'
# file 'video3.mp4'

ffmpeg -f concat -safe 0 -i list.txt -c copy output.mp4
```

### Method 2: Same Codec Files

```bash
# If all videos have same codec/format
ffmpeg -i "concat:video1.mp4|video2.mp4|video3.mp4" -c copy output.mp4
```

### Method 3: Re-encode (Different Codecs)

```bash
# Re-encode for compatibility
ffmpeg -f concat -safe 0 -i list.txt -c:v libx264 -c:a aac output.mp4
```

## Splitting Video

```bash
# Split into 60-second segments
ffmpeg -i input.mp4 -c copy -f segment -segment_time 60 \
  -reset_timestamps 1 output_%03d.mp4

# Split at specific timestamps
ffmpeg -i input.mp4 -ss 00:00:00 -t 00:01:00 -c copy part1.mp4
ffmpeg -i input.mp4 -ss 00:01:00 -t 00:01:00 -c copy part2.mp4
```

## Extract Segment with Re-encoding

```bash
# When you need to change quality/codec
ffmpeg -ss 00:00:10 -i input.mp4 -t 20 \
  -c:v libx264 -crf 23 -c:a aac -b:a 192k output.mp4
```

## Multiple Segments

```bash
# Extract multiple segments
ffmpeg -i input.mp4 \
  -ss 00:00:10 -t 00:00:05 -c copy segment1.mp4 \
  -ss 00:01:00 -t 00:00:10 -c copy segment2.mp4
```

## Notes

- Use `-c copy` for speed (no re-encoding)
- `-ss` before `-i` is faster but less precise
- `-ss` after `-i` is more precise but slower
- Concatenation requires same codec/format for `-c copy`
- Use file list method for best concatenation results
