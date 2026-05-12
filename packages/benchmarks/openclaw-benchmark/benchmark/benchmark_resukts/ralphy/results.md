# Ralphy Benchmark: Erster Testlauf

**Datum:** 2026-02-02
**Tool:** Ralphy v4.x (via npm)
**Engine:** OpenCode (Default Modelle)

## Ausgeführte PRD
(Basierend auf dem initialen Docker-Testlauf)

```markdown
- [ ] Create a hello world script
- [ ] Add error handling
```

## Ergebnisse

| Metrik | Wert |
|--------|------|
| **Status** | ✅ 100% Complete |
| **Dauer** | 11m 9s |
| **Durchschnitt pro Task** | ~5m 35s |
| **Integrität** | Sehr gut (Container isoliert) |

## Token & Kosten (Kritische Analyse)
Ralphy meldete am Ende: `Tokens: (295 in / 273 out)`.

**⚠️ Warnung:** Diese Zahlen sind höchstwahrscheinlich **falsch** oder unvollständig. 
- Ein 11-minütiger Lauf mit OpenCode-Agent-Interaktionen verbraucht typischerweise 10.000 - 50.000 Tokens. 
- Vermutung: Ralphy zählt nur die Token des *Orchestrator-Skripts* (Steuerung), nicht die der *Worker-Engine* (OpenCode-Agent).
- **Benchmark-Urteil:** Token-Reporting von Ralphy ist für Kostenkalkulation aktuell unbrauchbar.

## Erstellte Dateien im Test
- `hello.sh` (oder ähnlich)
- (Fehlerbehandlung wurde im Skript integriert)

## Beobachtungen
- Ralphy zeigt eine sehr stabile Loop.
- Das Interface ist rein informativ (keine TUI).
- Die Isolation im Container funktionierte perfekt.
