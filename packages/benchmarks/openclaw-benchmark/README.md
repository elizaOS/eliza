# 🤖 Benchmarking OpenClaw & Other AI Assistants

Dieses Repository enthält eine umfassende Testsuite und Benchmarking-Umgebung für verschiedene AI-Coding-Assistenten und OpenCode-Plugins. Das Ziel ist es, Metriken wie Ausführungsgeschwindigkeit, Token-Verbrauch und Code-Qualität in isolierten Docker-Umgebungen zu vergleichen.

## 📊 Benchmark-Ergebnisse & Ziel

Wir vergleichen die Leistung von AI Agents in standardisierten Szenarien.

### Getestete Agents / Tools

| Tool | Verzeichnis | Status | Beschreibung |
|------|-------------|--------|--------------|
| **Ralphy** | [`/ralphy`](./ralphy) | ✅ Ready | PRD-Orchestrator mit striktem Workflow |
| **OpenClaw** | [`/openclaw`](./openclaw) | 🔧 Setup | Autonomer Agent für komplexe Aufgaben |
| **Oh My OpenCode** | [`/ohmyopencode`](./ohmyopencode) | ⏳ Pending | Plugin-Sammlung und Hilfsmittel |
| **BMAD Method** | [`/bmadmethod`](./bmadmethod) | ⏳ Pending | Experimentelle Methodik |

---

## 🛠 Setup & Installation

### Voraussetzungen
- **Docker** & **Docker Compose**
- **OpenCode CLI** (optional, für lokale Entwicklung)
- **Node.js 20+**

### Starten der Benchmarks

Jeder Agent befindet sich in seinem eigenen Verzeichnis mit einem passenden `Dockerfile` und `run.sh` Skript.

**Beispiel: Starten von Ralphy**
```bash
cd ralphy
./run.sh
```

**Beispiel: Starten von OpenClaw**
```bash
cd openclaw
./run.sh
```

### Docker Naming-Convention

Das Projekt nutzt eine strikte Namenskonvention für Docker-Container, um Konflikte zu vermeiden und Filterung zu erleichtern.

- **Images**: `benchmark/<tool-name>` (z.B. `benchmark/ralphy`)
- **Container**: `benchmark--<tool-name>` (z.B. `benchmark--ralphy`)
- **Labels**: `project=benchmark`, `component=<tool-name>`

Alle aktiven Benchmark-Container anzeigen:
```bash
docker ps --filter 'label=project=benchmark'
```

---

## 🧪 Standard-Tasks

Alle Agents werden gegen denselben Satz von Aufgaben getestet, um Vergleichbarkeit zu gewährleisten.

Detaillierte Aufgabenbeschreibung: [📄 benchmark/standard_tasks.md](./benchmark/standard_tasks.md)

1. **Setup**: Initialisierung der Umgebung.
2. **Implementation**: Umsetzung eines Features (z.B. Weather CLI).
3. **Refactoring**: Code-Verbesserung.
4. **Testing**: Schreiben und Ausführen von Tests.

---

## 📈 Analyse

Detaillierte Analysen und Gedanken zur Architektur finden sich im Ordner [`my_idea`](./my_idea).

---

_Erstellt von [Enving](https://github.com/enving)_
