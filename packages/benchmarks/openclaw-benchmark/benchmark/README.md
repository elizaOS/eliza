# AI Agent Benchmarks

Benchmark-Ergebnisse für verschiedene OpenCode Plugins/Tools in isolierten Docker-Containern.

## Testumgebung

- **Container Base**: `node:20-slim` (Debian)
- **Isolation**: 100% (kein Zugriff auf Host-Konfigurationen)
- **OpenCode**: Frisch installiert via `curl -fsSL https://opencode.ai/install | bash`
- **Token-Tracking**: Langfuse Plugin (OpenTelemetry)

---

## Docker Naming-Convention

Alle Benchmark-Container folgen diesem Schema für einfache Filterung:

### Images
```
benchmark/<tool-name>
```
Beispiele:
- `benchmark/ralphy`
- `benchmark/openclaw`
- `benchmark/ohmyopencode`
- `benchmark/bmadmethod`

### Container
```
benchmark--<tool-name>
```
Beispiele:
- `benchmark--ralphy`
- `benchmark--openclaw`

### Labels
Jeder Container hat diese Labels:
```
project=benchmark
component=<tool-name>
purpose=benchmark
```

### Filter-Befehle
```bash
# Alle Benchmark-Container anzeigen
docker ps --filter 'label=project=benchmark'

# Nur Ralphy
docker ps --filter 'label=component=ralphy'

# Alle Benchmark-Images
docker images 'benchmark/*'

# Aufräumen (alle Benchmark-Container)
docker rm $(docker ps -aq --filter 'label=project=benchmark')
docker rmi $(docker images -q 'benchmark/*')
```

---

## Tools im Vergleich

| Tool | Ordner | Status | Typ |
|------|--------|--------|-----|
| Ralphy | `/ralphy` | ✅ Ready | PRD-Orchestrator |
| OpenClaw | `/openclaw` | 🔧 Setup | Autonomous Agent |
| oh-my-opencode | `/ohmyopencode` | ⏳ Pending | OpenCode Plugin |
| BMAD-METHOD | `/bmadmethod` | ⏳ Pending | Methodik |

---

## Standard-Benchmark

Alle Tools werden mit der gleichen PRD getestet:
→ [`standard_tasks.md`](./standard_tasks.md) (Weather CLI mit 4 Tasks)
