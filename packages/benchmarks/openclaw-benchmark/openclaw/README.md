# OpenClaw Benchmark Setup

Isolierte Docker-Umgebung zum Testen von [OpenClaw](https://github.com/openclaw/openclaw) – einem autonomen AI-Agenten.

## Schnellstart

```bash
sudo ./run.sh
```

## Im Container

### 1. Konfiguration (einmalig)
```bash
openclaw onboard
# Wizard durchlaufen: AI-Provider, API-Keys, etc.
```

### 2. Benchmark starten
```bash
openclaw "Lies PRD.md und erstelle weather.js gemäß der Aufgabe"
```

## Unterschied zu Ralphy

| Aspekt | Ralphy | OpenClaw |
|--------|--------|----------|
| **Typ** | PRD-Orchestrator | Autonomer Agent |
| **Steuerung** | Tasks aus PRD | Natürliche Sprache |
| **Engine** | OpenCode (extern) | Eigene LLM-Integration |

## Sicherheit

- ✅ Komplett isoliert
- ✅ Container wird nach `exit` gelöscht (`--rm`)
