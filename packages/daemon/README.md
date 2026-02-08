# @elizaos/daemon

Cross-platform daemon/service management for Eliza agents.

Provides a unified API for managing background services across platforms:
- **macOS**: LaunchAgents (launchd)
- **Linux**: systemd user services  
- **Windows**: Scheduled Tasks (schtasks)

## Installation

```bash
npm install @elizaos/daemon
```

## Quick Start

```typescript
import { installAgentService, isServiceRunning, stopService } from "@elizaos/daemon";

// Install an Eliza agent as a background service
await installAgentService({
  name: "my-eliza-agent",
  description: "My Eliza Agent",
  entryPoint: "/path/to/agent/index.js",
  workingDirectory: "/path/to/agent",
});

// Check if running
const running = await isServiceRunning("my-eliza-agent");
console.log(`Agent running: ${running}`);

// Stop the service
await stopService("my-eliza-agent");
```

## API

### Service Management

```typescript
// Install a service
installService(config: ServiceConfig): Promise<ServiceResult>

// Uninstall a service
uninstallService(name: string): Promise<ServiceResult>

// Start/stop/restart
startService(name: string): Promise<ServiceResult>
stopService(name: string): Promise<ServiceResult>
restartService(name: string): Promise<ServiceResult>

// Check status
isServiceInstalled(name: string): Promise<boolean>
isServiceRunning(name: string): Promise<boolean>
getServiceRuntime(name: string): Promise<ServiceRuntime>
```

### Service Configuration

```typescript
interface ServiceConfig {
  /** Unique service name/identifier */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Command to execute (first element is the executable) */
  command: string[];
  /** Working directory for the service */
  workingDirectory?: string;
  /** Environment variables */
  environment?: Record<string, string>;
  /** Auto-restart on failure (default: true) */
  restartOnFailure?: boolean;
  /** Restart delay in seconds (default: 5) */
  restartDelay?: number;
  /** Keep alive - restart if process exits (default: true) */
  keepAlive?: boolean;
  /** Run at system load/boot (default: true) */
  runAtLoad?: boolean;
}
```

### Platform-Specific Managers

For direct access to platform-specific functionality:

```typescript
import { launchdManager, systemdManager, schtasksManager } from "@elizaos/daemon";

// Use macOS-specific features
if (process.platform === "darwin") {
  const runtime = await launchdManager.getRuntime("my-service");
  console.log("Plist path:", runtime.platformInfo?.plistPath);
}
```

## Platform Details

### macOS (launchd)

Services are installed as user LaunchAgents in `~/Library/LaunchAgents/`.
Logs are written to `~/Library/Logs/{service-name}/`.

### Linux (systemd)

Services are installed as user units in `~/.config/systemd/user/`.
User lingering is automatically enabled to allow services to run without login.

### Windows (Task Scheduler)

Services are registered as scheduled tasks that run at user logon.
Tasks are configured with auto-restart on failure.

## License

MIT
