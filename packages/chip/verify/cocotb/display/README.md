# Display scanout cocotb KAT

`test_display_scanout.py` drives `rtl/display/e1_display_scanout.sv` — the
buildable subset of the E1 display pipeline: a real AXI4 read master that
streams a framebuffer out of DRAM, a byte-assembly pixel-format unpack stage
(RGB565 / packed RGB888 / XRGB8888), a register-programmed mode timing
generator, and the controller -> PHY (DPI/DSI) pixel boundary.

Tracked under `verify/rtl_gap_work_order.yaml#areas.display`
(`display-real-framebuffer-path`, `display-proof-gap`).

Run via the standalone gate:

    python3 scripts/check_display_scanout.py

PHYSICAL DEPENDENCY (out of scope): the DSI analog PHY, D-PHY lane serializers,
and panel DCS init are physical/analog. This suite drives and checks only the
*digital* DPI boundary signals (`pix_de`/`pix_hsync`/`pix_vsync`/`pix_valid`/
`pix_data`) that such a PHY consumes.
