# @elizaos/plugin-scheduling

The scheduling spine for elizaOS agents — the storage-agnostic `ScheduledTask` state machine **and** the always-loaded runtime primitive that HOSTS it.

Core TaskService owns the clock. Keep the runner storage-agnostic and inject host dependencies. Branch on typed triggers/gates, never prompt prose; do not import application hosts.

Build, test, and setup: [README.md](README.md).
