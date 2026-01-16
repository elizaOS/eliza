![Demo](https://github.com/user-attachments/assets/b33212a6-7bd1-4654-b658-8a2f9a3a8b77)

<p align="center">
  <a href="https://cdn.crabnebula.app/download/mediar/mediar/latest/platform/windows-x86_64">
    <img src="https://img.shields.io/badge/⬇_Download_for_Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" height="50">
  </a>
  &nbsp;&nbsp;
  <a href="https://app.mediar.ai">
    <img src="https://img.shields.io/badge/🌐_Use_on_macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Use on macOS" height="50">
  </a>
</p>

<p align="center">
  <a href="https://discord.gg/dU9EBuw7Uq">
    <img src="https://img.shields.io/discord/823813159592001537?color=5865F2&logo=discord&logoColor=white&style=flat-square" alt="Join us on Discord">
  </a>
  <a href="https://www.youtube.com/@mediar_ai">
    <img src="https://img.shields.io/badge/YouTube-@mediar__ai-FF0000?logo=youtube&logoColor=white&style=flat-square" alt="YouTube @mediar_ai">
  </a>
  <a href="https://crates.io/crates/computeruse-rs">
    <img src="https://img.shields.io/crates/v/computeruse-rs.svg" alt="Crates.io - computeruse-rs">
  </a>
  <a href="https://crates.io/crates/computeruse-workflow-recorder">
    <img src="https://img.shields.io/crates/v/computeruse-workflow-recorder.svg" alt="Crates.io - workflow recorder">
  </a>
</p>

<p align="center">
  <a href="https://github.com/mediar-ai/computeruse/blob/main/computeruse-mcp-agent/README.md#quick-install">
    <img alt="Install in Cursor" src="https://img.shields.io/badge/Cursor-Cursor?style=flat-square&label=Install%20MCP&color=22272e">
  </a>
  <a href="https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%7B%22computeruse-mcp-agent%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22computeruse-mcp-agent%22%5D%7D%7D">
    <img alt="Install in VS Code" src="https://img.shields.io/badge/VS_Code-VS_Code?style=flat-square&label=Install%20MCP&color=0098FF">
  </a>
  <a href="https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%7B%22computeruse-mcp-agent%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22computeruse-mcp-agent%22%5D%7D%7D">
    <img alt="Install in VS Code Insiders" src="https://img.shields.io/badge/VS_Code_Insiders-VS_Code_Insiders?style=flat-square&label=Install%20MCP&color=24bfa5">
  </a>
</p>

## 🤖 Computer Use MCP that controls your entire desktop

Give AI assistants (Claude, Cursor, VS Code, etc.) the ability to control your desktop and automate tasks across any application.

**Claude Code (one-liner):**
```bash
claude mcp add computeruse "npx -y computeruse-mcp-agent@latest"
```

**Other clients (Cursor, VS Code, Windsurf, etc.):**

Add to your MCP config file:
```json
{
  "mcpServers": {
    "computeruse-mcp-agent": {
      "command": "npx",
      "args": ["-y", "computeruse-mcp-agent@latest"],
      "env": {
        "LOG_LEVEL": "info",
        "RUST_BACKTRACE": "1"
      }
    }
  }
}
```

See the [MCP Agent README](https://github.com/mediar-ai/computeruse/tree/main/computeruse-mcp-agent) for detailed setup instructions.

### Why ComputerUse MCP?

- **Uses your browser session** - no need to relogin, keeps all your cookies and auth
- **Doesn't take over your cursor or keyboard** - runs in the background without interrupting your work
- **Works across all dimensions** - pixels, DOM, and Accessibility tree for maximum reliability

### Use Cases

- Create a new instance on GCP, connect to it using CLI
- Check logs on Vercel to find most common errors
- Test my app new features based on recent commits

## 🚀 What's new

- 01/09/26 - Mediar IDE (Cursor for Windows automation) is in public access - [download now](https://cdn.crabnebula.app/download/mediar/mediar/latest/platform/windows-x86_64)
- 10/30 Public alpha is live - [Cursor for Windows automation](https://www.mediar.ai)
- 09/26 ComputerUse was on [Cohere Labs podcast](https://www.youtube.com/watch?v=cfQxlk8KNmY), also [check the slides](https://092025-cohere.mediar.ai/)
- 08/25 Big release — NodeJS SDK in YAML workflows, run JS in browser, OS event recording → YAML generation in MCP, and more
- 08/25 [we raised $2.8m to give AI hands to every desktop](https://x.com/louis030195/status/1948745185178914929)

## 🧠 Why ComputerUse

### For Developers

- Create automations that work across any desktop app or browser
- Runs 100x faster than ChatGPT Agents, Claude, Perplexity Comet, BrowserBase, BrowserUse (deterministic, CPU speed, with AI recovery)
- >95% success rate unlike most computer use overhyped products
- MIT-licensed — fork it, ship it, no lock-in

We achieve this by pre-training workflows as deterministic code, and calling AI only when recovery is needed.

### For Teams

[Our public beta workflow builder](https://www.mediar.ai) + managed hosting:

- Record, map your processes, and implement the workflow without technical skills
- Deploy AI to execute them at >95% success rate without managing hundreds of Windows VMs
- Kill repetitive work without legacy RPA complexity, implementation and maintenance cost

## Feature Support

ComputerUse supports **Windows**, **macOS**, and **Linux**.

| Feature                      | Windows | macOS | Linux | Notes                                                |
| ---------------------------- | :-----: | :---: | :---: | ---------------------------------------------------- |
| **Core Automation**          |         |       |       |                                                      |
| Element Locators             |    ✅    |   ✅   |   ✅   | Find elements by `name`, `role`, `window`, etc.      |
| UI Actions (`click`, `type`) |    ✅    |   ✅   |   ✅   | Core interactions with UI elements.                  |
| Application Management       |    ✅    |   ✅   |   ✅   | Launch, list, and manage applications.               |
| Window Management            |    ✅    |   ✅   |   ✅   | Get active window, list windows.                     |
| **Advanced Features**        |         |       |       |                                                      |
| Browser Automation           |    ✅    |   ✅   |   ✅   | Chrome extension enables browser control.            |
| Workflow Recording           |    ✅    |   🟡   |   🟡   | Record human workflows for deterministic automation. |
| Monitor Management           |    ✅    |   ✅   |   ✅   | Multi-display support.                               |
| Screen & Element Capture     |    ✅    |   ✅   |   ✅   | Take screenshots of displays or elements.            |
| **Libraries**                |         |       |       |                                                      |
| Python (`computeruse.py`)     |    🟡    |   🟡   |   🟡   | `pip install computeruse`                             |
| TypeScript (`@elizaos/computeruse`) |    ✅    |   ✅   |   ✅   | `npm i @elizaos/computeruse`                        |
| Workflow (`@mediar-ai/workflow`) |    ✅    |   🟡   |   🟡   | `npm i @mediar-ai/workflow`                          |
| CLI (`@mediar-ai/cli`)       |    ✅    |   ✅   |   ✅   | `npm i @mediar-ai/cli`                               |
| KV (`@mediar-ai/kv`)         |    ✅    |   ✅   |   ✅   | `npm i @mediar-ai/kv`                                |
| MCP (`computeruse-mcp-agent`) |    ✅    |   ✅   |   ✅   | `npx -y computeruse-mcp-agent --add-to-app [app]`     |
| Rust (`computeruse-rs`)       |    ✅    |   ✅   |   ✅   | `cargo add computeruse-rs`                            |

**Legend:**

- ✅: **Supported** - The feature is stable and well-tested.
- 🟡: **Partial / Experimental** - The feature is in development and may have limitations.
- ❌: **Not Supported** - Not available on this platform.

**Platform Notes:**
- **macOS:** Requires Accessibility permissions (System Preferences → Privacy & Security → Accessibility)
- **Linux:** Requires AT-SPI2 (enabled by default on GNOME/KDE). For X11, install `wmctrl` and `xdotool`.

## 🕵️ How to Inspect Accessibility Elements (like `name:Seven`)

To create reliable selectors (e.g. `name:Seven`, `role:Button`, `window:Calculator`), you need to inspect the Windows Accessibility Tree:

### Windows

- **Tool:** [Accessibility Insights for Windows](https://accessibilityinsights.io/downloads/)
- **Alt:** [Inspect.exe](https://learn.microsoft.com/en-us/windows/win32/winauto/inspect-objects) (comes with Windows SDK)
- **Usage:** Open the app you want to inspect → launch Accessibility Insights → hover or use keyboard navigation to explore the UI tree (Name, Role, ControlType, AutomationId).

### macOS

- **Tool:** Accessibility Inspector (included with Xcode)
- **Alt:** `osascript -e 'tell application "System Events" to entire contents of window 1 of application process "Safari"'`
- **Usage:** Open Xcode → Developer Tools → Accessibility Inspector. Select the target process and inspect elements' AXRole, AXTitle, AXIdentifier attributes.
- **Requirement:** Grant Accessibility permissions to your automation script/terminal (System Preferences → Privacy & Security → Accessibility).

### Linux (Experimental)

- **Tool:** Accerciser (GNOME Accessibility Inspector)
- **Install:** `sudo apt install accerciser` or `sudo dnf install accerciser`
- **Usage:** Open Accerciser → navigate the AT-SPI tree to find element names, roles, and states.

> These tools show you the `Name`, `Role`, `ControlType`, and other metadata used in ComputerUse selectors.

### Platform Support

| Platform | CLI | MCP Agent | Automation | Installation Method |
|----------|:---:|:---------:|:----------:|---------------------|
| Windows  | ✅  | ✅        | ✅         | npm/bunx |
| macOS    | ✅  | ✅        | ✅         | npm/bunx (requires Accessibility permissions) |
| Linux    | ✅  | ✅        | ✅         | npm/bunx (requires AT-SPI2, wmctrl/xdotool) |

**Note:** 
- macOS requires Accessibility permissions for your terminal/app
- Linux requires AT-SPI2 (default on GNOME/KDE) and `wmctrl`/`xdotool` for X11 window management

## Troubleshooting

For detailed troubleshooting, debugging, and MCP server logs, [send us a message](https://www.mediar.ai/).

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests. many parts are experimental, and help is appreciated. 


