# Ralphy CLI Testumgebung

Isolierte Docker-Umgebung zum Testen von [Ralphy](https://github.com/michaelshimeles/ralphy) mit [OpenCode](https://opencode.ai/).

## Schnellstart

```bash
./run.sh
```

## Im Container

```bash
# OpenCode direkt starten
opencode

# Ralphy mit OpenCode
ralphy --opencode "create hello world"
ralphy --opencode --prd PRD.md
```

## Sicherheit

- ✅ Komplett isoliert
- ✅ Keine Verbindung zu deinem lokalen OpenCode
- ✅ Container wird nach `exit` gelöscht (`--rm`)

---

## Later: Antigravity Auth (ausgeklammert)

Falls du später große Modelle (Claude Opus 4.5, Gemini 3 Pro) nutzen willst:
→ Siehe [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)
