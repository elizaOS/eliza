# Vagrant Development Environment for MCP

This directory contains a complete Vagrant setup for local MCP development with hot reload capabilities.

## Features

- **Hot Reload**: MCP server automatically restarts when binary is rebuilt on host
- **Browser Extension Hot Reload**: Chrome extensions auto-reload on file changes
- **Windows 10 VM**: Full Windows environment for UI automation testing
- **Performance Optimized**: 8GB RAM, 4 CPUs, VirtualBox optimizations
- **Port Forwarding**: Access MCP and Chrome debugging from host
- **Development Tools**: Pre-installed Rust, Node.js, Python, Chrome, Git

## Quick Start

1. **Prerequisites**
   - Install [VirtualBox](https://www.virtualbox.org/)
   - Install [Vagrant](https://www.vagrantup.com/)

2. **Start the VM**
   ```bash
   cd vagrant
   vagrant up  # First time will take ~20 minutes
   ```

3. **Build MCP on Host**
   ```bash
   cd /c/Users/louis/Documents/computeruse
   cargo build --release
   ```

4. **Access Services**
   - MCP: http://localhost:8080/mcp
   - Health: http://localhost:8080/health
   - Chrome Debug: http://localhost:9222

## Hot Reload Setup

### MCP Server Hot Reload
The `scripts/mcp-watcher.ps1` script monitors the MCP binary and automatically restarts it when updated:
- Watches: `C:\Users\vagrant\computeruse\target\release\computeruse-mcp-agent.exe`
- Port: 8080
- Auto-starts on VM login via scheduled task

### Browser Extension Hot Reload
The `scripts/extension-watcher.ps1` script monitors browser extension files:
- Watches: `C:\Users\vagrant\computeruse\browser-extension\*`
- Auto-reloads Chrome extensions when files change
- Supports build step if package.json exists

## Directory Structure

```
vagrant/
├── Vagrantfile           # Main VM configuration
├── Vagrantfile-enhanced  # Enhanced version with all features
├── scripts/
│   ├── mcp-watcher.ps1        # MCP hot reload watcher
│   ├── extension-watcher.ps1  # Browser extension hot reload
│   ├── install-openssh.ps1    # SSH setup script
│   └── gui-shell/              # GUI automation shell
└── README-VAGRANT.md     # This file
```

## Development Workflow

1. **Edit code on host** in your favorite IDE
2. **Build on host**: `cargo build --release`
3. **MCP auto-restarts** in VM (watch the console)
4. **Test via API**: `curl http://localhost:8080/health`
5. **Run workflows**: `computeruse mcp run workflow.yml --url http://localhost:8080/mcp`

## VM Commands

```bash
# SSH into VM
vagrant ssh

# Restart VM
vagrant reload

# Suspend VM (saves state)
vagrant suspend

# Resume suspended VM
vagrant resume

# Destroy VM (clean slate)
vagrant destroy

# Re-provision (run setup scripts again)
vagrant provision
```

## Shared Folders

The computeruse repo is synced to the VM:
- Host: `../` (parent of vagrant folder)
- Guest: `C:\Users\vagrant\computeruse`
- Type: VirtualBox shared folder

## Installed Software

- **Development**
  - Rust & Cargo
  - Node.js & npm
  - Python 3
  - Git

- **Browsers**
  - Google Chrome (with remote debugging)

- **Utilities**
  - Scoop package manager
  - PSTools (PSExec for session management)
  - OpenSSH server

## Configuration

### VM Resources (Vagrantfile)
```ruby
vb.memory = 8192  # 8GB RAM
vb.cpus = 4       # 4 CPU cores
```

### Port Forwarding
```ruby
config.vm.network "forwarded_port", guest: 8080, host: 8080  # MCP
config.vm.network "forwarded_port", guest: 9222, host: 9222  # Chrome
config.vm.network "forwarded_port", guest: 22, host: 2222    # SSH
```

## Troubleshooting

### MCP not starting
```powershell
# Check if MCP is running
Get-Process computeruse* -ErrorAction SilentlyContinue

# Manually start MCP
C:\Users\vagrant\computeruse\target\release\computeruse-mcp-agent.exe -t http --host 0.0.0.0 -p 8080

# Check logs
Get-Content C:\MCP\logs\mcp-startup.log
```

### Hot reload not working
```powershell
# Check if watcher is running
Get-ScheduledTask MCPWatcher

# Manually run watcher
powershell C:\Users\vagrant\computeruse\vagrant\scripts\mcp-watcher.ps1
```

### Port already in use
```bash
# On host, check what's using port 8080
netstat -ano | findstr :8080
```

## Performance Tips

1. **Build on host, run in VM** - Much faster than building in VM
2. **Use suspend/resume** instead of shutdown/up
3. **Allocate more resources** if needed in Vagrantfile
4. **Disable Windows Defender** in VM for better performance

## Browser Extension Development

The extension watcher supports:
- Auto-reload on file changes
- npm build step if package.json exists
- Chrome DevTools Protocol integration
- Manual reload via Ctrl+R on chrome://extensions

Start Chrome with debugging:
```powershell
chrome.exe --remote-debugging-port=9222 --load-extension="C:\Users\vagrant\computeruse\browser-extension"
```

## Notes

- VM uses Windows 10 for full UIAutomation API support
- Auto-logon configured for unattended operation
- Power settings prevent sleep/hibernate
- Scheduled tasks run watchers on login