# Ralphy Benchmark

**Tool**: [Ralphy](https://github.com/michaelshimeles/ralphy)
**Version**: ralphy-cli (npm)
**Datum**: 2026-02-02

## Beschreibung

Ralphy ist ein autonomes CLI-Tool, das AI-Coding-Agents (Claude Code, OpenCode, Cursor, etc.) orchestriert, um Tasks aus einer PRD abzuarbeiten.

---

## Test 1: PRD mit 2 Tasks

### Aufgabe (PRD.md)

```markdown
# Sample PRD

## Tasks
- [ ] Create a hello world script
- [ ] Add error handling
```

### Befehl

```bash
ralphy --opencode --prd PRD.md
```

### Ergebnis

| Metrik | Wert |
|--------|------|
| **Status** | ✅ Erfolgreich |
| **Tasks abgeschlossen** | 2/2 |
| **Tasks fehlgeschlagen** | 0 |
| **Gesamtdauer** | 11m 9s |
| **Modus** | Sequential |

### Token-Verbrauch

| Richtung | Tokens |
|----------|--------|
| **Input** | 295 |
| **Output** | 273 |
| **Gesamt** | 568 |

### Output

```
[INFO] Starting Ralphy with OpenCode
[INFO] Tasks remaining: 2
[INFO] Mode: Sequential

[INFO] Task 1: Create a hello world script (2 remaining)
✔ Working [1m 24s] Create a hello world script (Working: 1m 24s) [1m 24s]
[INFO] Task 2: Add error handling (1 remaining)
✔ Working [9m 44s] Add error handling (Working: 9m 44s) [9m 44s]
[OK] All tasks completed!

==================================================
[INFO] Summary:
  Completed: 2
  Failed:    0
  Duration:  11m 9s
  Tokens:    (295 in / 273 out)
==================================================
```

---

## Fazit

- Ralphy funktioniert isoliert im Docker-Container
- OpenCode wird korrekt als Engine genutzt
- Token-Verbrauch sehr gering (568 total für 2 Tasks)
- Dauer: ~5.5 min pro Task im Durchschnitt
