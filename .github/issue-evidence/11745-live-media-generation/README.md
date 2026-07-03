# Issue 11745 Live Media Generation Evidence

Date: 2026-07-03

Environment: production `https://api.elizacloud.ai/api/v1`.

Auth: local `ELIZAOS_CLOUD_API_KEY` was loaded from the developer machine and sent as `X-API-Key`; the value is not recorded in any artifact.

## Passed Live Paths

| Surface | Result | Evidence |
| --- | --- | --- |
| Image generation | `POST /generate-image` returned 200 | `01-generate-image-response.json`, `generated-image.jpg` |
| SFX generation | `POST /generate-sfx` returned 200 | `03-generate-sfx-response.json`, `generated-sfx.wav`, `generated-sfx-waveform.png` |
| Music generation | `POST /generate-music` returned 200 | `04-generate-music-response.json`, `generated-music.mp3`, `generated-music-waveform.png` |
| Gallery readback | `GET /gallery?type=image` and `GET /gallery?type=video` returned 200 | `05-gallery-image-list.json`, `06-gallery-video-list.json` |
| Files CRUD | upload/list/get/download/delete/get-after-delete round trip completed | `07-files-upload-response.json` through `11-files-get-after-delete-response.json`, `upload-source.txt`, `uploaded-file.txt` |

## Manual Review

- Image: opened `generated-image.jpg`; it is a valid, nonblank generated image with a red square, green triangle, and blue circle on a white background, matching the verification prompt.
- SFX: `ffprobe` reports 3.000s stereo PCM WAV bytes. `generated-sfx-waveform.png` is non-silent with a clear attack and decay, matching the short bell/pop verification prompt.
- Music: `ffprobe` reports 110.631s stereo MP3. `generated-music-waveform.png` is non-silent with distinct musical sections.
- Files: `uploaded-file.txt` matches `upload-source.txt`; post-delete `GET /files/:id` returned 404 as expected.

## Video Residual

Live production video generation is still not green.

| Attempt | Model | Status | Request id | Result |
| --- | --- | --- | --- | --- |
| `02` | `vidu/q3-turbo/text-to-video` | 400 | `5791fb56-1460-4da3-b69f-56f89e971f0c` | production catalog does not yet support this develop model |
| `02b` | `fal-ai/pixverse/v5/text-to-video` | 500 | `e9e1209d-0974-4c13-85a2-3d49e766e273` | `internal_error` |
| `02c` | `fal-ai/veo3/fast` | 500 | `7a444493-0b58-4fcb-9c08-e1e997770793` | `internal_error` |
| `02d` | `fal-ai/minimax/hailuo-2.3/standard/text-to-video` | 500 | `0cfb31aa-a9f5-4e73-8665-fb123499b081` | `internal_error` |
| `02e` | `wan/v2.6/text-to-video` | 500 | `74b7ede0-a177-45c5-bd7e-106ab8f2a04e` | `internal_error` |

`bunx wrangler@latest secret list --env production` confirms the relevant production secret names exist: `ATLASCLOUD_API_KEY`, `FAL_KEY`, `FAL_API_KEY`, and `ELEVENLABS_API_KEY`. Secret values are write-only and were not printed. The video blocker is therefore not an absent-secret issue; it needs provider/runtime debugging on the production worker.

## Bug Found By Live Evidence

The music request asked for `durationSeconds: 10` and the route billed `totalCost: 0.02`, but the downloaded FAL MiniMax output is 110.631s. This appears to be a live provider contract/billing drift: the provider ignored or expanded the requested duration while the route billed the request duration.

## Local Validation

All of these commands completed successfully locally:

```bash
jq -e . .github/issue-evidence/11745-live-media-generation/*.json
cmp .github/issue-evidence/11745-live-media-generation/upload-source.txt .github/issue-evidence/11745-live-media-generation/uploaded-file.txt
file .github/issue-evidence/11745-live-media-generation/*
shasum -a 256 .github/issue-evidence/11745-live-media-generation/generated-* .github/issue-evidence/11745-live-media-generation/uploaded-file.txt
ffprobe -hide_banner -v error -show_entries stream=codec_name,codec_type,channels,sample_rate,duration -show_entries format=duration,size,bit_rate -of json .github/issue-evidence/11745-live-media-generation/generated-sfx.wav
ffprobe -hide_banner -v error -show_entries stream=codec_name,codec_type,channels,sample_rate,duration -show_entries format=duration,size,bit_rate -of json .github/issue-evidence/11745-live-media-generation/generated-music.mp3
git diff --check
```

The uploaded source and downloaded file both have sha256 `12d671a9b2fa7543b4aa01d64a80e60e2d025587b4baf400f6d46895602346b9`.
