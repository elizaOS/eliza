## Linux examples

Linux UI automation is supported via **AT-SPI2** (Assistive Technology Service Provider Interface).

> **Requirements:**
> - AT-SPI2 must be enabled (default on GNOME, KDE, and most modern desktops)
> - For X11: `wmctrl` and `xdotool` for window management
> - GUI session required (`DISPLAY` or `WAYLAND_DISPLAY` environment variable set)

**Note:** Results may vary by desktop environment. GNOME has the best AT-SPI2 support.

### Included

- `calculator/gnome_calculator_basic.py`
- `notepad/gnome_text_editor_basic.py`
- `screenshot/element_screenshot.py`
- `video/vlc_streaming_youtube.py`
- `menu/vlc_menu_open_file.py`
- `audio/playback_vlc.py`
- `audio/record_gnome_sound_recorder.py`

