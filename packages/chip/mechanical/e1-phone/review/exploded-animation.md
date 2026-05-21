# e1-phone exploded animation

- GLB: `/home/shaw/milady/eliza/packages/chip/mechanical/e1-phone/out/e1-phone-exploded.glb` (186,520 bytes)
- MP4: `/home/shaw/milady/eliza/packages/chip/mechanical/e1-phone/out/e1-phone-exploded.mp4` (917,782 bytes)
- Frames: `/home/shaw/milady/eliza/packages/chip/mechanical/e1-phone/out/e1-phone-exploded-frames` (360 frames, 24 keyframes)
- Clips: explode, reassemble, turntable
- Durations: explode 3.0s, hold 1.5s, reassemble 3.0s, hold 1.5s — total 12.0s @ 30fps
- Parts animated: 97
- Ring spacing: 25.0 mm
- Renderer: **pyrender-egl + ffmpeg/libx264**
- Render time: 47.1s

## Axis decisions
| Group | Axis |
|---|---|
| screen front stack (cover glass / display / adhesives / fpc) | +Z |
| back shell / PCB / battery / haptic / shields / antennas | -Z |
| power button + labyrinth | +X |
| volume button + labyrinth | -X |
| USB-C parts + bottom speaker/mics | -Y |
| earpiece + top mic + front camera | +Y |

## Re-run

```bash
python3 packages/chip/scripts/generate_e1_phone_exploded_animation.py
```

## Notes

- GLB is fully self-contained (vertex-colored, embedded buffer). Two translation clips named `explode` and `reassemble`, plus a 12s `turntable` rotation on the root.
- MP4 timeline within the 12s loop: 0–3s explode, 3–4.5s hold-exploded, 4.5–7.5s reassemble, 7.5–12s hold-assembled, all while the camera orbits Y at 30°/s with 12° tilt.
- Vertex colors are baked per part (orange shell stays safety orange; kapton flex is amber; PCB green; shields silver).
