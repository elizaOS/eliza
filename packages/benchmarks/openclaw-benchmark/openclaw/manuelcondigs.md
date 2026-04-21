OpenClaw onboarding
│
◇  Security ───────────────────────────────────────────────────────────╮
│                                                                      │
│  Security warning — please read.                                     │
│                                                                      │
│  OpenClaw is a hobby project and still in beta. Expect sharp edges.  │
│  This bot can read files and run actions if tools are enabled.       │
│  A bad prompt can trick it into doing unsafe things.                 │
│                                                                      │
│  If you’re not comfortable with basic security and access control,   │
│  don’t run OpenClaw.                                                 │
│  Ask someone experienced to help before enabling tools or exposing   │
│  it to the internet.                                                 │
│                                                                      │
│  Recommended baseline:                                               │
│  - Pairing/allowlists + mention gating.                              │
│  - Sandbox + least-privilege tools.                                  │
│  - Keep secrets out of the agent’s reachable filesystem.             │
│  - Use the strongest available model for any bot with tools or       │
│    untrusted inboxes.                                                │
│                                                                      │
│  Run regularly:                                                      │
│  openclaw security audit --deep                                      │
│  openclaw security audit --fix                                       │
│                                                                      │
│  Must read: https://docs.openclaw.ai/gateway/security                │
│                                                                      │
├──────────────────────────────────────────────────────────────────────╯
│
◇  I understand this is powerful and inherently risky. Continue?
│  Yes
│
◇  Onboarding mode
│  Manual
│
◇  What do you want to set up?
│  Local gateway (this machine)
│
◇  Workspace directory
│  /workspace
│
◇  Model/auth provider
│  Google
│
◇  Google auth method
│  Google Gemini API key
│
◇  Enter Gemini API key
│  [REDACTED_API_KEY]
│
◇  Model configured ─────────────────────────────────╮
│                                                    │
│  Default model set to google/gemini-3-pro-preview  │
│                                                    │
├────────────────────────────────────────────────────╯
│
◇  Default model
│  Keep current (google/gemini-3-pro-preview)
│
◇  Gateway port
│  31789
│
◇  Gateway bind
│  Loopback (127.0.0.1)
│
◇  Gateway auth
│  Token
│
◇  Tailscale exposure
│  Off
│
◇  Gateway token (blank to generate)
│
│
◇  Channel status ────────────────────────────╮
│                                             │
│  Telegram: not configured                   │
│  WhatsApp: not configured                   │
│  Discord: not configured                    │
│  Google Chat: not configured                │
│  Slack: not configured                      │
│  Signal: not configured                     │
│  iMessage: not configured                   │
│  Google Chat: install plugin to enable      │
│  Nostr: install plugin to enable            │
│  Microsoft Teams: install plugin to enable  │
│  Mattermost: install plugin to enable       │
│  Nextcloud Talk: install plugin to enable   │
│  Matrix: install plugin to enable           │
│  BlueBubbles: install plugin to enable      │
│  LINE: install plugin to enable             │
│  Zalo: install plugin to enable             │
│  Zalo Personal: install plugin to enable    │
│  Tlon: install plugin to enable             │
│                                             │
├─────────────────────────────────────────────╯
│
◆  Configure chat channels now?
│  ● Yes / ○ No
└

 Configure skills now? (recommended)
│  Yes
│
◇  Homebrew recommended ────────────────────────────────────────────────╮
│                                                                       │
│  Many skill dependencies are shipped via Homebrew.                    │
│  Without brew, you'll need to build from source or download releases  │
│  manually.                                                            │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  Show Homebrew install command?
│  Yes
│
◇  Homebrew install ────────────────────────────────────────────────────╮
│                                                                       │
│  Run:                                                                 │
│  /bin/bash -c "$(curl -fsSL                                           │
│  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)  │
│  "                                                                    │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  Preferred node manager for skill installs
│  npm
│
◆  Install missing skill dependencies
│  ◻ Skip for now (Continue without installing dependencies)
│  ◻ 🔐 1password
│  ◻ 📝 apple-notes
│  ◻ ⏰ apple-reminders
│  ◻ 🐻 bear-notes
│  ◻ 🐦 bird
│  ◻ 📰 blogwatcher
│  ◻ 🫐 blucli
│  ◻ 📸 camsnap
│  ◻ 🧩 clawhub
│  ◻ 🎛️ eightctl
│  ◻ ♊️ gemini
│  ◻ 🧲 gifgrep
│  ◻ 🐙 github
│  ◻ 🎮 gog
│  ◻ 📍 goplaces
│  ◻ 📧 himalaya
│  ◻ 📨 imsg
│  ◻ 📦 mcporter
│  ...◻ 📊 model-usage
│  ◻ 🍌 nano-banana-pro
│  ◻ 📄 nano-pdf
│  ◻ 💎 obsidian
│  ◻ 🎙️ openai-whisper
│  ◻ 💡 openhue
│  ◻ 🧿 oracle
│  ◻ 🛵 ordercli
│  ◻ 👀 peekaboo
│  ◻ 🗣️ sag
│  ◻ 🌊 songsee
│  ◻ 🔊 sonoscli
│  ◻ 🧾 summarize
│  ◻ ✅ things-mac
│  ◻ 🎞️ video-frames
│  ◻ 📱 wacli (Send WhatsApp messages to other people or 
│  search/sync WhatsApp history via the wacli CLI …)


Preferred node manager for skill installs
│  npm
│
◇  Install missing skill dependencies
│  🔐 1password
│
◇  Install failed: 1password — brew not installed
Tip: run `openclaw doctor` to review skills + requirements.
Docs: https://docs.openclaw.ai/skills
│
◇  Set GOOGLE_PLACES_API_KEY for goplaces?
│  No
│
◇  Set GOOGLE_PLACES_API_KEY for local-places?
│  No
│
◇  Set GEMINI_API_KEY for nano-banana-pro?
│  No
│
◆  Set NOTION_API_KEY for notion?
│  ○ Yes / ● No

  Configure skills now? (recommended)
│  Yes
│
◇  Homebrew recommended ────────────────────────────────────────────────╮
│                                                                       │
│  Many skill dependencies are shipped via Homebrew.                    │
│  Without brew, you'll need to build from source or download releases  │
│  manually.                                                            │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  Show Homebrew install command?
│  Yes
│
◇  Homebrew install ────────────────────────────────────────────────────╮
│                                                                       │
│  Run:                                                                 │
│  /bin/bash -c "$(curl -fsSL                                           │
│  https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)  │
│  "                                                                    │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  Preferred node manager for skill installs
│  npm
│
◇  Install missing skill dependencies
│  🔐 1password
│
◇  Install failed: 1password — brew not installed
Tip: run `openclaw doctor` to review skills + requirements.
Docs: https://docs.openclaw.ai/skills
│
◇  Set GOOGLE_PLACES_API_KEY for goplaces?
│  No
│
◇  Set GOOGLE_PLACES_API_KEY for local-places?
│  No
│
◇  Set GEMINI_API_KEY for nano-banana-pro?
│  No
│
◇  Set NOTION_API_KEY for notion?
│  No
│
◇  Set OPENAI_API_KEY for openai-image-gen?
│  No
│
◇  Set OPENAI_API_KEY for openai-whisper-api?
│  No
│
◇  Set ELEVENLABS_API_KEY for sag?
│  No
│
◇  Hooks ──────────────────────────────────────────────────────────╮
│                                                                  │
│  Hooks let you automate actions when agent commands are issued.  │
│  Example: Save session context to memory when you issue /new.    │
│                                                                  │
│  Learn more: https://docs.openclaw.ai/hooks                      │
│                                                                  │
├──────────────────────────────────────────────────────────────────╯
│
◆  Enable hooks?
│  ◻ Skip for now
│  ◻ 🚀 boot-md
│  ◻ 📝 command-logger
│  ◻ 💾 session-memory



Health check failed: gateway closed (1006 abnormal closure (no close frame)): no close reason
  Gateway target: ws://127.0.0.1:31789
  Source: local loopback
  Config: /root/.openclaw/openclaw.json
  Bind: loopback
│
◇  Health check help ────────────────────────────────╮
│                                                    │
│  Docs:                                             │
│  https://docs.openclaw.ai/gateway/health           │
│  https://docs.openclaw.ai/gateway/troubleshooting  │
│                                                    │
├────────────────────────────────────────────────────╯
Missing Control UI assets. Build them with `pnpm ui:build` (auto-installs UI deps).
│
◇  Optional apps ────────────────────────╮
│                                        │
│  Add nodes for extra features:         │
│  - macOS app (system + notifications)  │
│  - iOS app (camera/canvas)             │
│  - Android app (camera/canvas)         │
│                                        │
├────────────────────────────────────────╯
│
◇  Control UI ──────────────────────────────────────────────────────────╮
│                                                                       │
│  Web UI: http://127.0.0.1:31789/                                      │
│  Web UI (with token):                                                 │
│  http://127.0.0.1:31789/?token=43afc67726326ab73677190e0444efa164e1e  │
│  9ac8c441d55                                                          │
│  Gateway WS: ws://127.0.0.1:31789                                     │
│  Gateway: not detected (gateway closed (1006 abnormal closure (no     │
│  close frame)): no close reason)                                      │
│  Docs: https://docs.openclaw.ai/web/control-ui                        │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  Workspace backup ────────────────────────────────────────╮
│                                                           │
│  Back up your agent workspace.                            │
│  Docs: https://docs.openclaw.ai/concepts/agent-workspace  │
│                                                           │
├───────────────────────────────────────────────────────────╯
│
◇  Security ──────────────────────────────────────────────────────╮
│                                                                 │
│  Running agents on your computer is risky — harden your setup:  │
│  https://docs.openclaw.ai/security                              │
│                                                                 │
├─────────────────────────────────────────────────────────────────╯
│
◇  Dashboard ready ─────────────────────────────────────────────────────╮
│                                                                       │
│  Dashboard link (with token):                                         │
│  http://127.0.0.1:31789/?token=43afc67726326ab73677190e0444efa164e1e  │
│  9ac8c441d55                                                          │
│  Copy/paste this URL in a browser on this machine to control          │
│  OpenClaw.                                                            │
│  No GUI detected. Open from your computer:                            │
│  ssh -N -L 31789:127.0.0.1:31789 user@<host>                          │
│  Then open:                                                           │
│  http://localhost:31789/                                              │
│  http://localhost:31789/?token=43afc67726326ab73677190e0444efa164e1e  │
│  9ac8c441d55                                                          │
│  Docs:                                                                │
│  https://docs.openclaw.ai/gateway/remote                              │
│  https://docs.openclaw.ai/web/control-ui                              │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  Web search (optional) ───────────────────────────────────────────────╮
│                                                                       │
│  If you want your agent to be able to search the web, you’ll need an  │
│  API key.                                                             │
│                                                                       │
│  OpenClaw uses Brave Search for the `web_search` tool. Without a      │
│  Brave Search API key, web search won’t work.                         │
│                                                                       │
│  Set it up interactively:                                             │
│  - Run: openclaw configure --section web                              │
│  - Enable web_search and paste your Brave Search API key              │
│                                                                       │
│  Alternative: set BRAVE_API_KEY in the Gateway environment (no        │
│  config changes).                                                     │
│  Docs: https://docs.openclaw.ai/tools/web                             │
│                                                                       │
├───────────────────────────────────────────────────────────────────────╯
│
◇  What now ─────────────────────────────────────────────────╮
│                                                            │
│  What now: https://openclaw.ai/showcase ("What People Are  │
│  Building").                                               │
│                                                            │
├────────────────────────────────────────────────────────────╯
│
└  Onboarding complete. Use the tokenized dashboard link above to control OpenClaw.

│
◆  Install shell completion script?
│  ● Yes / ○ No