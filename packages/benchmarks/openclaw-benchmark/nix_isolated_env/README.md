# Nix Isolated Environment (Tool-Agnostic)

Vollständig isolierte Entwicklungsumgebung. **Jedes installierte Tool** landet im Projektordner, nicht in deinem echten Home.

## Wie die Isolation funktioniert

```
Normaler Linux-Prozess:
  $HOME = /home/enving
  → curl ... | bash installiert nach /home/enving/.local/bin/

Mit Nix-Isolation:
  $HOME = /pfad/zu/projekt/.isolated_home
  → curl ... | bash installiert nach /pfad/zu/projekt/.isolated_home/.local/bin/
```

**Warum das funktioniert:**
Linux-Tools lesen `$HOME` aus der Umgebung. Wenn wir `$HOME` ändern BEVOR ein Tool startet, nutzt es automatisch das neue Verzeichnis. Das Nix `shellHook` setzt `$HOME` beim Betreten der Shell.

## Setup

### 1. Nix installieren

```bash
sh <(curl -L https://nixos.org/nix/install) --daemon
```

### 2. Flakes aktivieren

```bash
mkdir -p ~/.config/nix
echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
```

### 3. Umgebung betreten

```bash
cd nix_isolated_env
nix develop
```

## Verwendung für Benchmarks

1. Kopiere `flake.nix` + `.envrc` in jeden Benchmark-Ordner
2. `cd benchmark_ordner && nix develop`
3. Installiere beliebige Tools – alles landet in `.isolated_home/`

```bash
# Beispiel: OpenCode installieren
curl -fsSL https://opencode.ai/install | bash

# Beispiel: Antigravity
npm install -g @anthropic/claude-code

# Alles landet in .isolated_home/, nicht in deinem echten Home
```
