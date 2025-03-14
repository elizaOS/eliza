# 🤖 Eliza Start Script

> A powerful, cross-platform launcher for your AI companion

## 🚀 Quick Start

```bash
# Linux/macOS from eliza root directory
./scripts/start.sh
```

## 💻 System Requirements

<details>
<summary><b>🐧 Linux</b></summary>

- Bash shell
- `sudo` access
- APT package manager
- 2GB free disk space
</details>

<details>
<summary><b>🍎 macOS</b></summary>

- macOS 10.15 or higher
- Command Line Tools
- Admin access
- 2GB free disk space
</details>

<details>
<summary><b>🪟 Windows (WSL2)</b></summary>

**Requirements:**
- Windows 10 version 2004+ or Windows 11
- 8GB RAM minimum
- Virtualization enabled in BIOS
- Admin access to install WSL2

**Installation Steps:**
1. Enable WSL2:
   ```powershell
   # Run in PowerShell as Administrator
   wsl --install
   ```

2. Install Ubuntu from Microsoft Store or:
   ```powershell
   wsl --install -d Ubuntu
   ```

3. Restart your computer

4. Set up Ubuntu:
   - Open Ubuntu from Start Menu
   - Create username and password when prompted
   - Run updates:
     ```bash
     sudo apt update && sudo apt upgrade -y
     ```

Now you can follow the Linux instructions!
</details>

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 OS Detection | Automatically adapts to your platform |
| 🛠️ Zero Config | Installs all dependencies automatically |
| 📦 Node.js | Manages versions and packages seamlessly |
| 🎭 Characters | Full character management interface |
| 🔄 Updates | One-click updates and version management |
| ⚙️ Environment | Guided configuration setup |

## 🎮 Usage

### Command Line Options
```bash
start.sh [-v|--verbose] [--skip-nvm]
```

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Show detailed progress |
| `--skip-nvm` | Use system Node.js |
### 🔄 Starting and Updating Eliza

| Action | Description |
|--------|-------------|
| Start | Launch current version |
| Update | Install latest updates |
| Reinstall | Fresh installation |

### 🎭 Character Management

<details>
<summary><b>Creating New Characters</b></summary>

1. Select `Create New`
2. Enter character name
3. Customize in editor
4. Save & deploy
</details>

<details>
<summary><b>Using Existing Characters</b></summary>

1. Select `Use Existing`
2. Choose characters:
   - Select each: `X`
   - Select All: `Ctrl+A`
   - Confirm: `ENTER`
</details>

<details>
<summary><b>Character Actions</b></summary>

**Single Character:**
- ▶️ Run
- ✏️ Edit
- 🗑️ Delete

**Multiple Characters:**
- ▶️ Run All
- 🗑️ Delete All
</details>

### ⚙️ Configuration



## 🛟 Troubleshooting

### Common Solutions

<details>
<summary><b>🔒 Permission Issues</b></summary>

```bash
# Linux/macOS
sudo chmod +x scripts/start.sh

# Windows
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```
</details>

<details>
<summary><b>📦 Node.js Issues</b></summary>

- Required: Node.js 22+
- Use `--skip-nvm` for system Node
- Check PATH configuration
</details>

<details>
<summary><b>🔧 Package Manager Issues</b></summary>

- Linux: `sudo apt update`
- macOS: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
- Windows: Run as Administrator
</details>

### 🚨 Common Errors


| `characters not found` | Check working directory |

## 📝 Notes

- Temporary files: `/tmp/eliza_*`
- Config location: `./config`
- Characters: `./characters/*.json`

## 🆘 Support

Need help? Try these steps:

1. Run with verbose logging:
   ```bash
   ./scripts/start.sh -v
   ```
2. Check console output
3. [Open an issue](https://github.com/elizaOS/eliza/issues)

---
<div align="center">
<i>Made with ❤️ by the ElizaOS team</i>
</div>
