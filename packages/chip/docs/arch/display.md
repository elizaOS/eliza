# Display contract

The e1 display block is a minimal synthesizable timing, address-generation,
and framebuffer-fetch scaffold. It keeps the existing framebuffer-oriented MMIO
contract and exposes a narrow read-side client interface that can be coupled to
DRAM or a verification memory model.

| Offset | Name | Access | Description |
| ---: | --- | --- | --- |
| `0x00` | `FB_BASE` | RW | Base address used to form scanout byte addresses |
| `0x04` | `MODE` | RW | `{height[15:0], width[15:0]}`; zero fields clamp to 1 |
| `0x08` | `FORMAT` | RW | FourCC-like format value; only `XR24` is accepted |
| `0x0C` | `ENABLE` | RW | Bit 0 enables scanout; disabled scanout holds counters at zero |
| `0x10` | `VSYNC` | RO | Bit 0 is the one-cycle vsync interrupt pulse |
| `0x14` | `UNDERFLOW_COUNT` | RW1C-like | Counts active pixels where framebuffer data was not ready; any write clears |
| `0x18` | `FETCHED_PIXEL_COUNT` | RW1C-like | Counts active pixels fetched from the framebuffer client; any write clears |

When enabled, the block generates active-high timing outputs:

```text
scan_active
scan_hsync
scan_vsync
scan_x
scan_y
scan_fb_addr
scan_rgb
fb_read_valid
fb_read_addr
fb_read_data
fb_read_ready
```

The current timing scaffold uses fixed porches around the programmable active
area: horizontal front/sync/back `16/96/48` pixels and vertical front/sync/back
`10/2/33` lines. During active pixels, `fb_read_valid` is asserted and
`scan_fb_addr`/`fb_read_addr` are `FB_BASE + 4 * (scan_y * width + scan_x)`.
Both addresses are zero outside the active region.

The `FORMAT` register resets to `XR24` and writes to unsupported formats are
ignored. `XR24` scanout treats each fetched word as `0x00RRGGBB` and drives
`scan_rgb` as `{R, G, B}` from `fb_read_data[23:0]` when `fb_read_ready` is high.
If an active pixel is not ready, `scan_rgb` is driven black for that pixel and
`UNDERFLOW_COUNT` increments. Successful active-pixel reads increment
`FETCHED_PIXEL_COUNT`.

The top-level e1-chip scope connects the framebuffer client to the
debug-visible SRAM-backed DRAM aperture at `0x8000_0000`. In-aperture aligned
read addresses return the corresponding framebuffer word; out-of-aperture or
unaligned active scanout addresses deassert `fb_read_ready`, drive black for
that pixel, and increment `UNDERFLOW_COUNT`. Verification covers both the
standalone client contract and the top-level memory-coupled scanout path.

This is still a one-word-at-a-time SRAM model, not a production display memory
client. A real shared memory/interconnect scanout port still needs buffering,
latency tolerance, bandwidth coverage, and format expansion beyond `XR24`.

The first Linux driver should treat this as a simple framebuffer or DRM/KMS
scanout device. Android should initially use software rendering and a minimal
HWC path.

## v0 reference panel

The e1 chip v0 targets a **720x1280 portrait MIPI-DSI** panel as the
software-visible reference. The concrete part is the **Raspberry Pi 7" DSI
Touch Display v1.1-class** module (or any panel compatible with the Linux
`simple-panel` driver advertising the same timing), chosen because:

- Active resolution `720 x 1280` fits the `MODE.width/height` fields and
  the current address-generator without modification.
- Pixel clock is approximately `83 MHz` at 60 Hz with the v0 fixed porches
  (`H_FRONT=16`, `H_SYNC=96`, `H_BACK=48`, `V_FRONT=10`, `V_SYNC=2`,
  `V_BACK=33`), which is well within the contract fabric budget.
- DSI 4-lane physical layer is well-supported by open-source bridge IP
  (e.g., the Cadence MIPI-DSI controller open spec).
- Native format is `RGB888` packed to `XR24` on the framebuffer side,
  matching the existing `FORMAT.XR24` requirement; no format conversion
  is needed for v0.

### Initialization sequence summary

The v0 panel init path is driven by the boot firmware before the kernel
takes over. The full DSI command set lives in `fw/panel/v0_init.bin`; the
high-level order is:

1. Assert panel reset (`PANEL_RST_N = 0`) for `>= 10 ms`, then release
   and wait `>= 120 ms` for the panel controller to come out of reset.
2. Power up DSI PHY lanes; configure as 4-lane HS, `~1 Gbps/lane`.
3. Send `DCS SOFT_RESET (0x01)`; wait `>= 5 ms`.
4. Send `DCS SET_PIXEL_FORMAT (0x3A)` with `0x77` (24 bpp packed RGB888).
5. Send vendor-specific PLL/voltage commands per the panel datasheet
   (opaque blob from `fw/panel/v0_init.bin`).
6. Send `DCS EXIT_SLEEP_MODE (0x11)`; wait `>= 120 ms`.
7. Send `DCS SET_DISPLAY_ON (0x29)`.
8. Begin scanout: program `FB_BASE`, `MODE = (1280 << 16) | 720`,
   `FORMAT = XR24`, then `ENABLE = 1`.

This sequence is the boot-time prerequisite; nothing in the current
`e1_display` RTL implements the DSI command path. The DSI controller
and its command FIFO are tracked under the
`display-real-framebuffer-path` gap. Until that lands, the v0 contract
is exercised in cocotb against a synthetic perfect or starved
framebuffer client (see `verify/cocotb/display/`).
