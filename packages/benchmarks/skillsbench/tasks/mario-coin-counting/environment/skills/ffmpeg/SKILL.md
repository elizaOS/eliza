---
name: ffmpeg-keyframe-extraction
description: Extract key frames (I-frames) from video files using FFmpeg command line tool. Use this skill when the user needs to pull out keyframes, thumbnails, or important frames from MP4, MKV, AVI, or other video formats for analysis, previews, or processing.
license: Complete terms in LICENSE.txt
---

# FFmpeg Keyframe Extraction

Extract key frames (I-frames) from video files using FFmpeg CLI.

## Prerequisites

- FFmpeg installed and available in PATH
- Input video file (MP4, MKV, AVI, MOV, etc.)

## Methods

### Method 1: Select Filter (More Control)

```bash
ffmpeg -i <input_video> -vf "select='eq(pict_type,I)'" -vsync vfr <output_pattern>
Method 2: Skip Frame (Faster)

ffmpeg -skip_frame nokey -i <input_video> -vsync vfr <output_pattern>
Key Options
Option	Description
-i <file>	Input video file
-vf "select='eq(pict_type,I)'"	Filter selecting only I-frames
-skip_frame nokey	Skip decoding non-keyframes (performance)
-vsync vfr	Variable frame rate, prevents duplicates
-q:v <n>	Quality (1-31, lower = better, for JPEG)
-frame_pts 1	Use presentation timestamp in filename
Output Patterns
frame_%03d.png - PNG sequence (frame_001.png, frame_002.png...)
frame_%03d.jpg - JPEG sequence
frame_%d.bmp - BMP sequence
Examples
Basic PNG extraction:
```
ffmpeg -i video.mp4 -vf "select='eq(pict_type,I)'" -vsync vfr keyframe_%03d.png
High-quality JPEG:
```

```
ffmpeg -i video.mp4 -skip_frame nokey -vsync vfr -q:v 2 keyframe_%03d.jpg
With timestamps:
```

```
ffmpeg -i video.mp4 -vf "select='eq(pict_type,I)'" -vsync vfr -frame_pts 1 keyframe_%d.png
```

To specific directory:

```
ffmpeg -i video.mp4 -vf "select='eq(pict_type,I)'" -vsync vfr ./output/keyframe_%03d.png
```

## Notes
Method 2 (-skip_frame nokey) is faster as it skips decoding non-keyframes
Method 1 offers more filtering flexibility (can combine with other filters)
Keyframe frequency depends on video encoding settings
Use -vsync vfr to avoid duplicate frames in output
