# SVG Draw

Create SVG images and convert them to PNG without external graphics libraries.

## When to Use

- Generating custom illustrations, avatars, or artwork
- Creating logos or icons
- Converting SVG files to PNG format

## How It Works

1. Write SVG markup directly (no PIL/ImageMagick required)
2. Use system `rsvg-convert` for PNG conversion

```bash
rsvg-convert input.svg -o output.png -w 512 -h 512
```
