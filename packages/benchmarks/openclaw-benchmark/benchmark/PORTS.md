# Port-Belegung

Eine zentrale Übersicht aller genutzten Ports, um Kollisionen zu vermeiden.

## 1. OpenCoworkers (Host Services)
Das Hauptsystem (Web UI, Daemon, Runtime).

| Service | Port (Container) | **Port (Host)** | Beschreibung |
| :--- | :--- | :--- | :--- |
| **Web UI** | 80 | **7850** | React Dashboard (The Face) |
| **Daemon** | 3847 | **7851** | Orchestrator Node.js API (The Brain) |
| **Runtime** | 4096 | **7852** | OpenCode Agent Sandbox (The Hands) |
| **OnlyOffice** | 80 | **7853** | Dokumenten-Server (Optional) |

## 2. OpenClawWorkers (Experiment)
Das Worker- und Tooling-Setup.

| Service | Port (Container) | **Port (Host)** | Beschreibung |
| :--- | :--- | :--- | :--- |
| **Worker Dashboard** | 3000 | **13000** | Web-Interface / Kanban Board |
| **OpenClaw Gateway** | 18789 | **18789** | API Gateway |
| **SearXNG** | 8080 | **18080** | Lokale Suche |
| **PostgreSQL** | 5432 | **15432** | Datenbank |
| **Nextcloud** (opt) | 80 | **18081** | Datei-Sync |
| **Mailpit Web** (opt) | 8025 | **18025** | E-Mail UI |
| **Mailpit SMTP** (opt) | 1025 | **11025** | SMTP Server |

## 3. Benchmark Coding Agents (Isolated Docker)
Separate Testumgebungen für verschiedene Tools.

| Tool | Port (Container) | **Port (Host)** | Beschreibung |
| :--- | :--- | :--- | :--- |
| **OpenClaw Bench** | 3000 | **31000** | Gateway UI für den Isolation-Test |
| **Ralphy** | - | - | CLI (OpenCode läuft intern im Container) |
| **Oh My OpenCode** | - | - | CLI (OpenCode läuft intern im Container) |
| **BMAD-METHOD** | - | - | CLI (OpenCode läuft intern im Container) |

---

> **Hinweis:** Ralphy, Oh My OpenCode und BMAD nutzen OpenCode **innerhalb** ihres Docker-Containers. Sie greifen **nicht** auf den Runtime-Service (7852) des Hosts zu, um 100% Isolation und Reproduzierbarkeit zu gewährleisten.
