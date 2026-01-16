# Quick Start - Vagrant Development Environment

## Prerequisites Installation

**Run these steps first:**

1. **Run the setup script** (requires Administrator):
   ```powershell
   cd C:\Users\louis\Documents\computeruse\vagrant
   PowerShell -ExecutionPolicy Bypass -File setup-vagrant.ps1
   ```
   This will install:
   - Scoop package manager
   - VirtualBox 7.0.14
   - Vagrant

2. **Verify installation**:
   ```cmd
   vagrant --version
   VBoxManage --version
   ```

## Starting the Development VM

**Option 1: Use the quick start script**
```cmd
cd C:\Users\louis\Documents\computeruse\vagrant
start-dev-vm.cmd
```

**Option 2: Manual commands**
```cmd
cd C:\Users\louis\Documents\computeruse\vagrant
vagrant up
```

First time startup takes ~20 minutes to:
- Download Windows 10 base box
- Configure VM resources (8GB RAM, 4 CPUs)
- Install development tools
- Set up MCP hot reload

## Using the Development Environment

### Access Points
- **MCP Server**: http://localhost:8080/mcp
- **Health Check**: http://localhost:8080/health
- **Chrome Debug**: http://localhost:9222

### Development Workflow

1. **Build MCP on your host machine**:
   ```bash
   cd C:\Users\louis\Documents\computeruse
   cargo build --release
   ```

2. **MCP automatically restarts in VM** when the binary changes!
   - The watcher script monitors `target/release/computeruse-mcp-agent.exe`
   - Restarts happen within seconds of build completion

3. **Test your changes**:
   ```bash
   # Test MCP health
   curl http://localhost:8080/health

   # Run a workflow
   computeruse mcp run workflow.yml --url http://localhost:8080/mcp

   # Execute single tool
   computeruse mcp exec --url http://localhost:8080/mcp get_applications
   ```

### SSH into the VM
```bash
vagrant ssh
```

Inside the VM:
- MCP binary: `C:\Users\vagrant\computeruse\target\release\computeruse-mcp-agent.exe`
- Logs: `C:\MCP\logs\`
- Watcher scripts: `C:\Users\vagrant\computeruse\vagrant\scripts\`

## VM Management

### Stop the VM (preserves state)
```bash
vagrant suspend
```

### Resume suspended VM
```bash
vagrant resume
```

### Restart VM
```bash
vagrant reload
```

### Destroy VM (clean slate)
```bash
vagrant destroy
```

### Re-provision (update tools)
```bash
vagrant provision
```

## Features

✅ **Hot Reload** - MCP restarts automatically when you rebuild
✅ **Port Forwarding** - Access MCP from host at localhost:8080
✅ **Shared Folder** - Code synced between host and VM
✅ **Pre-installed Tools** - Rust, Node.js, Python, Chrome, Git
✅ **Performance Optimized** - 8GB RAM, 4 CPUs, VirtualBox optimizations

## Troubleshooting

### MCP not accessible
```powershell
# Check if VM is running
vagrant status

# Check MCP process in VM
vagrant ssh -c "Get-Process computeruse* -ErrorAction SilentlyContinue"

# Check port forwarding
netstat -ano | findstr :8080
```

### Hot reload not working
```powershell
# Check watcher task in VM
vagrant ssh -c "Get-ScheduledTask MCPWatcher"

# Manually restart MCP
vagrant ssh -c "Get-Process computeruse* | Stop-Process -Force"
```

### Build errors
Make sure you're building with the Windows target:
```bash
cargo build --release --target x86_64-pc-windows-msvc
```

## Next Steps

1. **Build MCP**: `cargo build --release`
2. **Start VM**: `start-dev-vm.cmd`
3. **Test MCP**: Open http://localhost:8080/health
4. **Make changes** and watch them auto-reload!

## Notes

- The VM uses the same Windows 10 base image as Azure deployments
- MCP binary is already at `C:\MCP\computeruse-mcp-agent.exe` in the VM
- Telemetry can be configured via environment variables
- Chrome is pre-installed for UI automation testing