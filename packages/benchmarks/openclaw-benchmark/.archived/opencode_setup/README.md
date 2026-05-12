# ACT (Autonomous Coding Template)

Das Repository, das sich selbst schreibt - gesteuert von OpenCode mit Agenten-Plugins.

## 🚀 Setup

1. **Installiere OCX & Plugins** (einmalig)
   ```bash
   # Install OCX (Plugin Manager)
   curl -fsSL https://ocx.kdco.dev/install.sh | sh
   export PATH="$HOME/.local/bin:$PATH"

   # Install Core Plugins
   ocx init --global
   ocx registry add https://registry.kdco.dev --name kdco --global
   ocx add kdco/workspace --global
   ```

2. **Starte OpenCode**
   ```bash
   opencode
   ```

## 🛡️ Sicherheit

Wir nutzen eine strikte `opencode.json` im Projekt-Root:
- **Blockiert** Zugriff auf Dateien außerhalb des Projekts (`external_directory: deny`)
- **Fragt** bei kritischen Aktionen (`edit`, `bash`, `task`)
- **Erlaubt** harmlose Aktionen (`read`, `list`, `grep`)

## 🤖 Features

Dank der installierten `kdco` Plugins hast du Zugriff auf:

| Feature | Befehl / Tool |
|---|---|
| **Git Worktrees** | `worktree_create("feat/xyz")` → Isoliertes Arbeiten |
| **Background Agents** | `delegate("Research X...")` → Agents arbeiten im Hintergrund |
| **Notifications** | Desktop Notify wenn Task fertig |

## 🧪 Testen

Um sicher zu experimentieren, erstelle einen Worktree:
```javascript
// In OpenCode eingeben:
worktree_create("test/experiment")
```
Das öffnet ein neues Terminal im isolierten Worktree.
