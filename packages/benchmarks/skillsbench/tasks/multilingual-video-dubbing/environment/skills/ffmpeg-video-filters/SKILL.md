---
name: FFmpeg Video Filters
description: Apply video filters - scale, crop, watermark, speed, blur, and visual effects
---

# FFmpeg Video Filters Skill

Apply video filters for scaling, cropping, watermarks, speed changes, and visual effects.

## When to Use

- Resize videos
- Crop video frames
- Add watermarks or overlays
- Change playback speed
- Apply blur or other effects
- Adjust brightness/contrast

## Scaling

```bash
# Scale to 720p (maintain aspect ratio)
ffmpeg -i input.mp4 -vf scale=-2:720 output.mp4

# Scale to specific width (maintain aspect ratio)
ffmpeg -i input.mp4 -vf scale=1280:-2 output.mp4

# Scale to exact dimensions (may distort)
ffmpeg -i input.mp4 -vf scale=1920:1080 output.mp4

# Scale with algorithm
ffmpeg -i input.mp4 -vf scale=1280:720:flags=lanczos output.mp4
```

## Cropping

```bash
# Crop to 16:9 from center
ffmpeg -i input.mp4 -vf "crop=1920:1080" output.mp4

# Crop with offset (x:y:width:height)
ffmpeg -i input.mp4 -vf "crop=1920:1080:0:0" output.mp4

# Crop from specific position
ffmpeg -i input.mp4 -vf "crop=800:600:100:50" output.mp4
```

## Watermarks and Overlays

```bash
# Add image watermark (top-left)
ffmpeg -i input.mp4 -i logo.png \
  -filter_complex "overlay=10:10" output.mp4

# Bottom-right watermark
ffmpeg -i input.mp4 -i logo.png \
  -filter_complex "overlay=W-w-10:H-h-10" output.mp4

# Center watermark
ffmpeg -i input.mp4 -i logo.png \
  -filter_complex "overlay=(W-w)/2:(H-h)/2" output.mp4
```

## Speed Changes

```bash
# Speed up 2x
ffmpeg -i input.mp4 -vf "setpts=0.5*PTS" -af "atempo=2.0" output.mp4

# Slow down 0.5x
ffmpeg -i input.mp4 -vf "setpts=2.0*PTS" -af "atempo=0.5" output.mp4

# Speed up video only (no audio)
ffmpeg -i input.mp4 -vf "setpts=0.5*PTS" -an output.mp4
```

## Blur Effects

```bash
# Blur entire video
ffmpeg -i input.mp4 -vf "boxblur=10:5" output.mp4

# Blur specific region (coordinates x:y:w:h)
ffmpeg -i input.mp4 -vf "boxblur=10:5:x=100:y=100:w=200:h=200" output.mp4

# Gaussian blur
ffmpeg -i input.mp4 -vf "gblur=sigma=5" output.mp4
```

## Brightness and Contrast

```bash
# Adjust brightness and contrast
ffmpeg -i input.mp4 -vf "eq=brightness=0.1:contrast=1.2" output.mp4

# Increase brightness
ffmpeg -i input.mp4 -vf "eq=brightness=0.2" output.mp4

# Adjust saturation
ffmpeg -i input.mp4 -vf "eq=saturation=1.5" output.mp4
```

## Rotation

```bash
# Rotate 90 degrees clockwise
ffmpeg -i input.mp4 -vf "transpose=1" output.mp4

# Rotate 90 degrees counter-clockwise
ffmpeg -i input.mp4 -vf "transpose=2" output.mp4

# Rotate 180 degrees
ffmpeg -i input.mp4 -vf "transpose=1,transpose=1" output.mp4
```

## Multiple Filters

```bash
# Chain multiple filters
ffmpeg -i input.mp4 -vf "scale=1280:720,crop=800:600:100:50" output.mp4

# Complex filter chain
ffmpeg -i input.mp4 -i logo.png \
  -filter_complex "[0:v]scale=1280:720[scaled];[scaled][1:v]overlay=10:10" \
  output.mp4
```

## Fade Effects

```bash
# Fade in (first 2 seconds)
ffmpeg -i input.mp4 -vf "fade=t=in:st=0:d=2" output.mp4

# Fade out (last 2 seconds)
ffmpeg -i input.mp4 -vf "fade=t=out:st=10:d=2" output.mp4

# Fade in and out
ffmpeg -i input.mp4 -vf "fade=t=in:st=0:d=2,fade=t=out:st=8:d=2" output.mp4
```

## Notes

- Use `-vf` for video filters
- Multiple filters separated by commas
- Use `-filter_complex` for complex operations
- Overlay positions: W=width, H=height, w=overlay width, h=overlay height
- Speed changes require both video (setpts) and audio (atempo) filters
