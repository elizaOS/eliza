# OpenWork Architectural Analysis

This document provides a comprehensive analysis of the OpenWork architecture and its components, serving as a reference for the development of OpenCoworkers.

## 🏗️ Architecture Overview

OpenWork is built on a modern desktop stack designed for performance, security, and developer experience.

- **Framework**: [Tauri 2.x](https://v2.tauri.app/) - Provides a lightweight, secure bridge between the Rust backend and the web-based frontend.
- **Frontend**: [SolidJS](https://www.solidjs.com/) - A declarative, efficient, and flexible JavaScript library for building user interfaces.
- **Backend**: Rust - Manages the system-level operations and the lifecycle of the OpenCode server.

### Core Integration
The frontend communicates with the backend and the OpenCode system through:
- **@opencode-ai/sdk**: Used for structured API interactions and state management.
- **Server-Sent Events (SSE)**: Used for real-time streaming of agent activity, logs, and status updates.

---

## 🔧 Key Components

### 1. OpenCode Server Management
The Rust backend is responsible for:
- Starting, stopping, and monitoring the `opencode` server process.
- Managing environment variables and configurations required for the server.
- Handling binary updates and system dependencies.

### 2. Skills Manager
- **File Reference**: `src-tauri/src/opkg.rs`
- **Functionality**: Manages the installation, discovery, and configuration of OpenCode skills.
- **Implementation**: It interacts with the `opkg` and `openpackage` commands to perform package management operations. It provides a UI for users to browse a "Skill Store" and manage their local installations.

### 3. Permission System
- **File Reference**: `src/app/session.ts`
- **Functionality**: Enforces a "Human-in-the-loop" security model.
- **Implementation**: The system listens for `permission.asked` events emitted by the OpenCode server. When an agent requests a sensitive action (like file deletion or network access), the UI intercepts this event and prompts the user for:
    - **Allow Once**: One-time permission.
    - **Allow Always**: Permanent permission for this skill/action.
    - **Deny**: Rejects the action.

---

## 🚀 Adaptation Strategy for OpenCoworkers (Team Orchestration)

While OpenWork is optimized for a single-user desktop experience, OpenCoworkers will adapt these concepts for enterprise team orchestration.

### 1. From Desktop to Team UI
- **Multi-Instance Support**: Adapt the Tauri architecture to handle multiple project contexts simultaneously.
- **Centralized Management**: Shift from local process management to interacting with remote OpenCode instances or a centralized team server.

### 2. Enterprise Permissions
- **RBAC (Role-Based Access Control)**: Extend the `permission.asked` listener to support team-wide policies.
- **Audit Trails**: Log permission decisions not just locally, but to a shared audit log (e.g., Jira comments or a dedicated database) to track who approved what.
- **Team-Level Approvals**: Allow managers to set "Auto-Approve" policies for specific agents or repositories.

### 3. Shared Skill Catalog
- **Centralized Skills**: Instead of purely local `opkg` management, implement a team-wide skill repository where skills can be shared across all coworkers.
- **Skill Versioning**: Ensure all team members use consistent versions of skills to maintain workflow reproducibility.

### 4. Integration with PM Tools
- **Sync Engine Integration**: The UI will directly reflect the state of the `SyncEngine`, showing Jira/Plane tickets alongside agent activity.
- **Status Mapping**: Map Tauri lifecycle events to PM tool status transitions (e.g., "App Launch" -> "Sync Pull").

---

## 🎯 Conclusion
The OpenWork architecture provides a solid foundation for the OpenCoworkers UI. By leveraging Tauri + SolidJS and the existing permission/skill patterns, we can rapidly build a professional, secure desktop command center for our virtual workforce.
