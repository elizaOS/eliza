## ComputerUse examples (by platform)

This folder contains runnable examples for automating common desktop tasks using `computeruse`.

### Layout

- `windows/` — Windows automation examples (Notepad, Calculator, MS Paint, Snipping Tool, VLC, screenshots, audio)
- `macos/` — macOS examples (TextEdit, Calculator, screenshots, audio, VLC) — **fully supported via Accessibility API**
- `linux/` — Linux examples (GNOME Text Editor, GNOME Calculator, screenshots, audio, VLC) — **AT-SPI2 support** (requires wmctrl/xdotool for X11)
- `cross-platform/` — Examples that work across all platforms (Gmail automation, monitor info)

#### Utilities (TypeScript)

- `mcp-client-elicitation/` — MCP client example for HTTP and stdio connections
- `recaptcha-resolver/` — reCAPTCHA resolver utility
- `strip-ui-styles/` — UI style stripping utility

> **Note:** UI selectors vary by OS and app versions. If a locator fails, inspect your accessibility tree and adjust selectors.
> **macOS** requires Accessibility permissions (System Preferences → Privacy & Security → Accessibility) for the calling app.
> **Linux** AT-SPI support is experimental; use a Windows host + MCP agent if needed for production.

### Quick start

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -U pip
pip install computeruse Pillow
```

Then run a script, for example:

```bash
# Windows
python windows/notepad/notepad_basic.py

# macOS
python macos/calculator/calculator_basic.py

# Linux
python linux/calculator/gnome_calculator_basic.py

# Cross-platform
python cross-platform/gmail_automation.py
```
