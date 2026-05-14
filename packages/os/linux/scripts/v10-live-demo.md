# Live demo — the "dream world" walkthrough

This is the test we've been building toward. Boot the latest ISO in
QEMU GUI, then have Eliza build your computer in front of you. v11
adds **LLM-rephrase**: once you sign into Claude in step 3, every
Action reply is re-phrased by real Eliza voice, not a preset template.

## Setup

```bash
# Full-screen launcher — picks the newest ISO, opens QEMU full-screen on
# the primary monitor at 2560x1440, wires SSH on :2223, sets up audio.
# Run `scripts/run-vm.sh --windowed` for a draggable window instead.
scripts/run-vm.sh
```

Under the hood the script does:

```bash
sudo pkill -9 -f qemu-system-x86_64 || true   # kill any stale QEMU
qemu-system-x86_64 \
    -enable-kvm -cpu host -m 8G -smp 6 \
    -cdrom out/usbeliza-v18-final-amd64.iso -boot d \
    -netdev user,id=net0,hostfwd=tcp::2223-:22 \
    -device virtio-net-pci,netdev=net0 \
    -vga none -device virtio-vga,xres=2560,yres=1440 \
    -device virtio-keyboard-pci -device virtio-tablet-pci \
    -audiodev pa,id=snd0 -device intel-hda -device hda-duplex,audiodev=snd0 \
    -display gtk,full-screen=on,zoom-to-fit=on,grab-on-hover=on,show-cursor=on \
    -name usbeliza
```

Mouse capture: hover into the window for input; press **Ctrl+Alt+G** to release. Exit full-screen mode via QEMU's `View` menu (toggle with Ctrl+Alt+F) and close the window to shut down the VM.

Wait ~90s for boot. You should see:

1. **Orange GRUB splash** for ~2 seconds → auto-advance
2. **Plymouth orange wordmark** with pulsing dot
3. **Black screen with chat box centered** — Eliza says hello

## The script

Eliza asks the 10 onboarding questions in this order. Type the answers
in the input field; the agent's state machine advances through each turn.

| # | Eliza says | You type |
|---|---|---|
| 1 | "Hi. I'm Eliza. What should I call you?" | your name |
| 2 | "I'm running on the local model on this stick — fast enough to talk. Want to get on Wi-Fi now?" | `yes` |
| | (multi-turn wifi flow takes over) | follow Eliza's network picker |
| 3 | "And want to sign into Claude or Codex?" | `yes` |
| | (chromium opens with the Claude OAuth URL) | complete OAuth in the popup |
| | (Eliza polls the token file, reports "signed in") | |
| 4 | "What do you spend most of your computer time on?" | freeform |
| 5 | "Lots of tools at once, or one focused workspace?" | `many` or `one` |
| 6 | "Morning or evening person?" | `morning` / `evening` / `depends` |
| 7 | "When something I build doesn't work — fix quietly or tell you?" | `tell me` or `fix quietly` |
| 8 | "What keyboard layout do you use?" | `us` / `dvorak` / etc |
| 9 | "What language should I speak with you?" | `english` / `français` / etc |
| 10 | "What timezone are you in?" | `UTC` / `PST` / `America/Los_Angeles` |

Then a warm contextual handoff: *"OK, [name]. I have what I need to start. ..."*

## The "build my computer" sequence — the dream world demo

Now the magic. Type these one at a time and watch the desktop materialize:

```
make me a space wallpaper with stars
```
→ Eliza runs ImageMagick, saves to `~/.eliza/wallpapers/space-with-stars.png`,
   swaymsg's it as the background. Your screen turns deep blue with
   white speckle dots.

```
build me a taskbar at the top with the time and the battery
```
→ Eliza calls `claude --print` with a panel-top brief. Claude returns
   HTML for a thin status strip. Sandbox launches it. Sway's
   `for_window [app_id="^usbeliza\.panel-top\..*"]` rule docks it at
   the top of the screen. Sticky across workspaces.

```
build me a dock on the right side with my apps
```
→ panel-right runtime. 64px-wide vertical strip docks at the right.
   Buttons for whichever apps Eliza thinks are useful.

```
build me a notes app
```
→ webview runtime — normal fullscreen sandboxed window. Real Claude
   writes the HTML.

```
build me a little weather widget in the top-right corner
```
→ widget runtime. 240x240 floating, `focus_on_window_activation none`,
   anchored at top-right.

```
make me a pomodoro timer
```
→ widget runtime, smaller. Floats next to the weather widget.

```
list my apps
```
→ "You've built five so far — space-with-stars wallpaper, taskbar from
   2 min ago, dock from a minute ago, notes, weather. Which would you
   like to open?"

```
delete my dock
```
→ "Removed your dock."

```
change my wallpaper to a sunset gradient
```
→ ImageMagick paints again, swaymsg switches.

The entire desktop is now records of conversations.

## What to check while testing

- **GRUB renders themed** (orange splash + 2s auto-advance, no countdown text)
- **Plymouth shows orange Eliza wordmark + pulsing dot** during the boot
- **No double title bar** in the chat window
- **No persistent topbar** — just the chat input + transcript
- **Orange "Eliza" name prefix** on each agent turn
- **No menus/bullets in any reply** — warm conversational prose
- **Wifi multi-turn picker** actually walks through SSID → password
- **Claude OAuth opens chromium fullscreen** + closes when token detected
- **Wallpaper visually changes** when SET_WALLPAPER fires
- **Panel/dock/widget windows position correctly** per sway for_window rules
- **Action replies sound like Eliza, not templates** — after Claude sign-in,
  "Built your clock. Opening it now." should come back as something like
  "Done. Your clock's opening on screen — should be there in a second."
  (LLM-rephrase via `runtime.useModel(TEXT_LARGE)`). If you see a preset
  string verbatim, set `USBELIZA_LLM_REPLIES=1` and restart the agent.

## If something breaks

SSH into the running QEMU:
```bash
ssh -i vm/.ssh/usbeliza_dev_ed25519 -p 2223 eliza@127.0.0.1

# Diagnostics:
systemctl --failed
sudo journalctl -u eliza-agent.service -b --no-pager | tail -50
sudo journalctl -u elizad-session-interactive.service -b --no-pager | tail -50
curl -s http://127.0.0.1:41337/api/status
cat ~/.eliza/calibration.toml
cat ~/.eliza/flow.toml 2>/dev/null
ls ~/.eliza/apps/
ls ~/.eliza/wallpapers/
```

Live-patch any agent fix:
```bash
# From host: scp the fix in, restart the service
rsync -e 'ssh -i vm/.ssh/usbeliza_dev_ed25519 -p 2223' \
    -a agent/src/ eliza@127.0.0.1:/opt/usbeliza/agent/src/
ssh -i vm/.ssh/usbeliza_dev_ed25519 -p 2223 eliza@127.0.0.1 \
    'sudo systemctl restart eliza-agent.service'
```

The user can iterate from chat without leaving the dream world.
