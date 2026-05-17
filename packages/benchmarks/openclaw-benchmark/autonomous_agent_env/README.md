# 🤖 Autonomous OpenCode Agent (Nix-basiert)

Vollständig isolierte Entwicklungsumgebung für OpenCode + Firecrawl mit Antigravity-Authentifizierung.

## Voraussetzungen

- **Nix** mit Flakes aktiviert
  ```bash
  # Falls noch nicht installiert:
  sh <(curl -L https://nixos.org/nix/install) --daemon
  
  # Flakes aktivieren:
  mkdir -p ~/.config/nix
  echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
  ```

## Quick Start

```bash
# 1. Umgebung betreten
cd autonomous_agent_env
nix develop

# 2. Setup ausführen (nur beim ersten Mal)
./setup.sh

# 3. Authentifizieren
opencode auth login

# 4. Los geht's!
opencode
```

## Was ist isoliert?

ALLES. Diese Umgebung hat ein eigenes `$HOME`:

```
autonomous_agent_env/
└── .isolated_home/           ← Alles landet hier
    ├── .opencode/bin/opencode
    ├── .config/opencode/
    │   ├── opencode.json
    │   └── antigravity.json
    └── .npm-global/
        └── bin/firecrawl
```

Dein echtes `~/.config/opencode` bleibt unberührt.

## Befehle

| Befehl | Beschreibung |
|--------|--------------|
| `nix develop` | Umgebung betreten |
| `./setup.sh` | Installiert OpenCode + Firecrawl |
| `opencode auth login` | Authentifizierung |
| `opencode` | OpenCode starten |
| `firecrawl` | Firecrawl nutzen |
| `exit` | Umgebung verlassen |


## Aufräumen

```bash
# Alles löschen und neu anfangen:
rm -rf .isolated_home
```

## 🧠 Architektur & Kontext (Für Agenten)

Dieses Repository ist ein hochspezialisiertes Testbett für autonome Agenten.

### 1. Komponenten
- **Firecrawl Self-Hosted:** Läuft lokal (Docker) auf Port 3002.
  - **Grund:** Vermeidung von Cloud-Credits und volle Kontrolle über Scraping.
  - **Config:** `opencode.json` erzwingt Nutzung via `mcp.firecrawl`. Default `webfetch` Tools sind deaktiviert!
- **OpenCode Source (`opencode_src`):** Liegt als Submodule vor.
  - **Zweck:** Introspektion interner Tools (z.B. `webfetch.ts`), um Verhalten zu verstehen/manipulieren.
- **Ralphy Integration (`ralphy_src` & Wrapper):**
  - **Ralphy Wrapper:** `./ralphy-wrapper.sh` implementiert den "Ralphy Loop" (PRD.md -> OpenCode Auto-Mode -> Update PRD).
  - **Ziel:** Ermöglicht völlig autonomen Betrieb basierend auf Checklisten.

### 2. Roadmap (siehe ``features.json``)
- **Meta-Agent:** Der nächste Schritt ist die Implementierung eines "Ralphy Skill", damit der Agent *selbst* den Wrapper aufrufen kann (Rekursion).
- **Sub-Agents:** Nutzung paralleler Worktrees (inspiriert von `ralphy_src`), um Aufgaben zu parallelisieren.

### 3. Wichtige Dateien
- `features.json`: Die "Wahrheit" über den Entwicklungsstand.
- `opencode.json`: Die "Gehirn-Konfiguration" (Tools an/aus).
- `setup.sh`: Der "Big Bang" Befehl für Reproduzierbarkeit.
