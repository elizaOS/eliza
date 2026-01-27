# Security Configuration

## Overview

The Dev Orchestrator plugin includes comprehensive authorization controls to restrict access to potentially dangerous operations. By default, if no authorization is configured, the plugin allows all users (backwards compatible). Once you configure authorization, only specified users will be able to execute actions.

## Authorization Levels

### 1. Authorized Users
Users who can submit tasks and view queue status.

### 2. Admin Users
Users who can:
- Submit tasks
- Approve/reject tasks
- Rollback changes
- All authorized user permissions

## Configuration

### Environment Variables

Add these to your `.env` file or character settings:

```bash
# Authorized users (can submit tasks, view queue)
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["user123", "alice", "bob"]'

# Authorized roles (Discord/Telegram roles)
DEV_ORCHESTRATOR_AUTHORIZED_ROLES='["admin", "developer"]'

# Admin users (can approve/reject tasks)
DEV_ORCHESTRATOR_ADMIN_USERS='["admin123", "alice"]'

# Require approval for all actions (optional)
DEV_ORCHESTRATOR_REQUIRE_APPROVAL='false'

# Command allowlist (safe commands that don't require approval)
DEV_ORCHESTRATOR_COMMAND_ALLOWLIST='["bun install", "npm install", "bun run build"]'
```

### Character File Configuration

```json
{
  "name": "DevBot",
  "plugins": ["@elizaos/plugin-dev-orchestrator"],
  "settings": {
    "DEV_ORCHESTRATOR_MODE": "trust",
    "DEV_ORCHESTRATOR_AUTHORIZED_USERS": "[\"user123\", \"alice\"]",
    "DEV_ORCHESTRATOR_AUTHORIZED_ROLES": "[\"admin\", \"developer\"]",
    "DEV_ORCHESTRATOR_ADMIN_USERS": "[\"admin123\"]"
  }
}
```

## User Identification

The authorization system identifies users by:

1. **User ID**: The unique identifier from the messaging platform (Discord ID, Telegram ID, etc.)
2. **Username**: The username from the message metadata
3. **Roles**: Role names from the message metadata (Discord roles, etc.)

## Action Permissions

### Submit Code Task (`SUBMIT_CODE_TASK`)
- **Required**: Authorized user or authorized role
- **Risk**: High - Executes code changes
- **Who can use**: Any authorized user

### Approve Task (`APPROVE_TASK`)
- **Required**: Admin user
- **Risk**: High - Commits code changes
- **Who can use**: Admin users only

### Reject Task (`REJECT_TASK`)
- **Required**: Admin user
- **Risk**: Medium - Rolls back changes
- **Who can use**: Admin users only

### Rollback Changes (`ROLLBACK_CHANGES`)
- **Required**: Authorized user
- **Risk**: Medium - Discards uncommitted changes
- **Who can use**: Any authorized user

### Queue Status (`QUEUE_STATUS`)
- **Required**: None (read-only)
- **Risk**: Low - Only views information
- **Who can use**: Anyone

## Command Approval System

In addition to user authorization, the plugin includes a command approval system for risky shell commands.

### Auto-Approved Commands (Allowlist)

These commands are considered safe and execute without approval:
- `bun install`, `npm install`, `yarn install`, `pnpm install`
- `bun run build`, `npm run build`
- `git status`, `git diff`, `git stash`, `git add`, `git commit`

### Commands Requiring Approval

These commands require explicit user approval:
- `rm -rf` (file deletion)
- `sudo` (elevated privileges)
- Shell redirects (`>`, `>>`)
- Network commands piped to shell (`curl | sh`, `wget | sh`)
- `eval`, `exec` (code execution)
- `chmod +x` (permission changes)

## Security Best Practices

### 1. Always Configure Authorization

```bash
# ❌ BAD: No authorization configured (allows everyone)
# (no settings)

# ✅ GOOD: Explicit authorization
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["alice", "bob"]'
DEV_ORCHESTRATOR_ADMIN_USERS='["alice"]'
```

### 2. Use Separate Admin Users

```bash
# ❌ BAD: All users are admins
DEV_ORCHESTRATOR_ADMIN_USERS='["alice", "bob", "charlie"]'

# ✅ GOOD: Limited admins
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["alice", "bob", "charlie"]'
DEV_ORCHESTRATOR_ADMIN_USERS='["alice"]'
```

### 3. Use Roles for Team Management

```bash
# ✅ GOOD: Use Discord/Telegram roles
DEV_ORCHESTRATOR_AUTHORIZED_ROLES='["developer", "devops"]'
DEV_ORCHESTRATOR_ADMIN_USERS='["alice"]'
```

### 4. Customize Command Allowlist

```bash
# Add project-specific safe commands
DEV_ORCHESTRATOR_COMMAND_ALLOWLIST='[
  "bun install",
  "bun run build",
  "bun run test",
  "docker-compose up -d"
]'
```

### 5. Enable Approval for Critical Projects

```bash
# Require approval for all actions
DEV_ORCHESTRATOR_REQUIRE_APPROVAL='true'
```

## Example Scenarios

### Scenario 1: Solo Developer

```bash
# You're the only user, no restrictions needed
# (no authorization configured - allows all)
```

### Scenario 2: Small Team

```bash
# Everyone can submit tasks, only lead can approve
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["alice", "bob", "charlie"]'
DEV_ORCHESTRATOR_ADMIN_USERS='["alice"]'
```

### Scenario 3: Large Team with Roles

```bash
# Use Discord roles for authorization
DEV_ORCHESTRATOR_AUTHORIZED_ROLES='["developer", "qa"]'
DEV_ORCHESTRATOR_ADMIN_USERS='["alice", "bob"]'
```

### Scenario 4: Production Environment

```bash
# Strict controls, approval required
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["alice", "bob"]'
DEV_ORCHESTRATOR_ADMIN_USERS='["alice"]'
DEV_ORCHESTRATOR_REQUIRE_APPROVAL='true'
DEV_ORCHESTRATOR_MODE='isolated'
```

## Troubleshooting

### User Getting "Not Authorized" Message

1. Check if user ID or username is in authorized list
2. Verify user roles match authorized roles
3. Check if authorization is configured at all (empty = allow all)
4. Enable debug logging to see authorization checks

### Commands Being Blocked

1. Check if command is in the allowlist
2. Add safe commands to custom allowlist
3. Approve commands manually when prompted

## Audit Logging

All authorization checks are logged:

```
[AuthorizationService] Admin user authorized: alice
[AuthorizationService] User authorized by role: bob
[AuthorizationService] User not authorized: charlie
```

Monitor these logs to track access attempts and adjust authorization as needed.

## Migration Guide

### From No Authorization to Authorized

1. **Start**: No authorization configured (allows all)
2. **Add authorized users**: Only they can submit tasks
3. **Add admin users**: Only they can approve/reject
4. **Test**: Verify unauthorized users are blocked
5. **Monitor**: Check logs for unauthorized attempts

### Example Migration

```bash
# Week 1: Add authorization (backwards compatible)
DEV_ORCHESTRATOR_AUTHORIZED_USERS='["alice", "bob", "charlie"]'

# Week 2: Separate admins
DEV_ORCHESTRATOR_ADMIN_USERS='["alice"]'

# Week 3: Enable strict mode
DEV_ORCHESTRATOR_REQUIRE_APPROVAL='true'
```

## Support

If you encounter authorization issues:

1. Check configuration syntax (valid JSON arrays)
2. Verify user IDs/usernames match exactly
3. Enable debug logging
4. Review audit logs
5. Test with a known admin user first

