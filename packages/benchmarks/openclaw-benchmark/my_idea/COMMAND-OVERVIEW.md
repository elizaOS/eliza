# OpenCode Custom Commands - Übersicht

**Last Updated**: 2026-01-16
**Maintained by**: Tristan Häfele

---

## 📋 Verfügbare Commands

### 1. `/checkpoint` - Full Session End
**Location**: `~/.config/opencode/command/checkpoint.md`
**Agent**: general
**Duration**: 2-3 Minuten

**Purpose**: Kompletter Session-Abschluss mit Cleanup, Docs-Update, Git-Commit, Handoff-Prompt

**Wann nutzen**:
- ✅ Ende jeder Arbeitssession (MANDATORY)
- ✅ Nach mehreren abgeschlossenen Tasks
- ✅ Vor Projektübergabe
- ✅ Tages-Abschluss

**Was es macht**:
1. ✓ Prüft & erstellt fehlende Files (PRD.md, tasks.json)
2. ✓ Räumt Repository auf (temp files, cache)
3. ✓ Updated `.agent-config/tasks.json`
4. ✓ Synct Markdown Docs (agents.md, next-steps.md, dev-rules.md, PRD.md)
5. ✓ Git Commit mit Author-Info
6. ✓ Generiert Handoff-Prompt für nächsten Agent
7. ✓ (Optional) Sync-Status wenn opencode-sync läuft

**Command**:
```bash
/checkpoint
```

**Output**:
- Zusammenfassung der Änderungen
- Git Commit erstellt
- **Handoff-Prompt** (kopierfähig für nächste Session)

---

### 2. `/review` - Code Review Workflow
**Location**: `~/.config/opencode/command/review.md`
**Agent**: general
**Duration**: 30-60 Minuten

**Purpose**: Review von completed Tasks/Features vom vorherigen Agent

**Wann nutzen**:
- ✅ Nach Arbeit eines vorherigen Agents
- ✅ Wenn Tasks `requires_review: true` haben
- ✅ Vor Deployment kritischer Features
- ✅ Quality Assurance Workflow

**Was es macht**:
1. ✓ Liest tasks.json für Review-Targets
2. ✓ Verifiziert Files & Code existieren
3. ✓ Testet Funktionalität
4. ✓ Dokumentiert Findings (approved / changes_requested)
5. ✓ Updated tasks.json mit Review-Status
6. ✓ Updated Markdown Docs
7. ✓ Erstellt Handoff wenn Issues gefunden

**WICHTIG**:
- ⚠️ Du kannst NUR Arbeit von ANDEREN Agents reviewen
- ⚠️ Niemals eigene Arbeit reviewen (Review Policy!)

**Command**:
```bash
/review
```

**Output**:
- Review Summary (Approved/Changes Requested)
- Updated tasks.json mit `reviewed_by`, `review_status`, `review_notes`
- Handoff für nächsten Agent wenn Fixes nötig

---

### 3. `/handoff` - Quick Session Handoff
**Location**: `~/.config/opencode/command/handoff.md`
**Agent**: general
**Duration**: 30 Sekunden

**Purpose**: Schneller Handoff-Prompt OHNE Cleanup/Commit

**Wann nutzen**:
- ✅ Mid-session agent switch
- ✅ Schneller Kontext-Transfer
- ✅ Übergabe an Spezial-Agent (plan → build)
- ✅ Brauchst Handoff aber nicht bereit für Commit

**Was es macht**:
1. ✓ Liest aktuellen State (tasks.json, git status)
2. ✓ Identifiziert completed/in-progress/blocked
3. ✓ Generiert strukturierten Handoff-Prompt
4. ✓ Output copy-pasteable Text
5. ✓ **KEINE** Datei-Änderungen, kein Commit

**Command**:
```bash
/handoff
```

**Output**:
- Handoff-Prompt (kopierfähig)
- Keine Side-Effects

**Unterschied zu /checkpoint**:
| Feature | /handoff | /checkpoint |
|---------|----------|-------------|
| Handoff-Prompt | ✅ | ✅ |
| Update tasks.json | ❌ | ✅ |
| Update Docs | ❌ | ✅ |
| Git Commit | ❌ | ✅ |
| Cleanup | ❌ | ✅ |
| Duration | 30s | 2-3min |

---

### 4. `/sync` - Manual Ticket System Sync
**Location**: `~/.config/opencode/command/sync.md`
**Agent**: general
**Duration**: 10-30 Sekunden

**Purpose**: Manueller Sync mit externem Ticket-System (Jira/Notion/Plane)

**REQUIRES**:
- `opencode-sync` daemon installiert & running
- `.agent-config/sync.json` konfiguriert

**Wann nutzen**:
- ✅ Force immediate sync (nicht warten auf auto-sync)
- ✅ Resolve sync conflicts
- ✅ Initial project setup
- ✅ Debug sync issues

**Was es macht**:
1. ✓ Triggert manuellen Sync
2. ✓ Push: tasks.json → Tickets
3. ✓ Pull: Tickets → tasks.json
4. ✓ Resolve Conflicts
5. ✓ Zeigt Sync Status

**Commands**:
```bash
# Bidirectional sync
/sync

# Oder spezifischer:
opencode-sync push    # Local → Tickets
opencode-sync pull    # Tickets → Local
opencode-sync sync    # Both directions

# Conflicts
opencode-sync conflicts list
opencode-sync conflicts resolve TASK-001 --strategy tasks_json_wins

# Status
opencode-sync status --verbose
```

**Output**:
- Sync Status
- Conflict Report (wenn vorhanden)
- Synced Tasks Count

---

## 🔄 Command Workflow

### Typische Session (Full Cycle)

```
Session Start
    │
    ├─ (Optional) /sync pull      # Hole neueste Tickets
    │
    ▼
Work on tasks...
    │
    ├─ (Optional) /handoff        # Quick switch zu anderem Agent
    │
    ▼
More work...
    │
    ├─ (Optional) /review         # Review previous agent work
    │
    ▼
Feature complete
    │
    ├─ (Optional) /sync push      # Push changes zu Tickets
    │
    ▼
Session End
    │
    └─ /checkpoint (MANDATORY)    # Full cleanup + commit + handoff
```

---

## 🎯 Decision Tree: Welcher Command?

```
Brauchst du Git Commit?
├─ JA
│  └─ /checkpoint
│
└─ NEIN
   │
   Brauchst du Code Review?
   ├─ JA
   │  └─ /review
   │
   └─ NEIN
      │
      Brauchst du Handoff-Prompt?
      ├─ JA
      │  ├─ Mit Cleanup? → /checkpoint
      │  └─ Ohne Cleanup? → /handoff
      │
      └─ NEIN
         │
         Brauchst du Ticket Sync?
         ├─ JA
         │  └─ /sync
         │
         └─ NEIN
            └─ Kein Command nötig
```

---

## 📚 Command Details

### /checkpoint
**Schritte**:
1. Projekt-Struktur sicherstellen
2. Repository aufräumen
3. tasks.json aktualisieren
4. Markdown Docs aktualisieren
5. Git Commit
6. Zusammenfassung
7. **Handoff-Prompt** (MANDATORY)

**Output-Beispiel**:
```
✅ Checkpoint Complete

Updated:
- .agent-config/tasks.json (3 tasks completed)
- agents.md
- next-steps.md
- PRD.md

Git commit: abc123d
"docs: update documentation for checkpoint"

═══════════════════════════════════════
HANDOFF FOR NEXT AGENT
═══════════════════════════════════════

[... Handoff Prompt ...]

═══════════════════════════════════════
```

---

### /review
**Review Policy**:
> "Reviews can only be done by NEXT agent, not same agent"

**Schritte**:
1. Read tasks.json for review targets
2. Verify files exist
3. Check implementation quality
4. Test functionality
5. Document findings
6. Update tasks.json
7. Update docs
8. (Optional) Git commit

**Review Status Values**:
- `approved`: Code ist gut, ready
- `changes_requested`: Issues gefunden, Fixes nötig
- `pending`: Review noch nicht abgeschlossen

**Output-Beispiel**:
```
Code Review Summary

Approved: 2 tasks ✅
- TASK-001: Implement login
- TASK-002: Add logout

Changes Requested: 1 task ⚠️
- TASK-003: Password reset
  Issues:
  - Missing rate limiting
  - Template file not found
  - No edge case tests
```

---

### /handoff
**Leichtgewichtig**: Keine Datei-Änderungen!

**Schritte**:
1. Read current state
2. Identify what to hand off
3. Generate handoff prompt
4. Output copy-pasteable text

**Output-Beispiel**:
```
═══════════════════════════════════════
COPY-PASTE HANDOFF PROMPT
═══════════════════════════════════════

=== HANDOFF FOR NEXT AGENT ===

🎯 CURRENT STATUS
Completed:
- ✅ TASK-001
- ✅ TASK-002

In Progress:
- 🔄 TASK-003 (60% done)

📝 NEXT STEPS
1. Complete TASK-003
2. Review TASK-001, TASK-002
3. ...

═══════════════════════════════════════
```

---

### /sync
**Requires Setup**:
```bash
# Install
npm install -g @opencode/sync

# Initialize
opencode-sync init

# Add adapter
opencode-sync add-adapter jira

# Start daemon
opencode-sync start
```

**Adapter Support**:
- ✅ Jira
- ✅ Notion
- ✅ Linear
- ✅ GitHub Issues
- ✅ Plane
- 🔜 Asana, ClickUp, Monday (community)

**Sync Modes**:
- `bidirectional`: Tasks ↔ Tickets (both ways)
- `push_only`: Tasks → Tickets (one way)
- `pull_only`: Tickets → Tasks (one way)

---

## 🛠️ Setup Commands

### Initial Project Setup

```bash
# 1. Ensure structure exists
cd your-project
opencode
/checkpoint

# This creates:
# - PRD.md
# - .agent-config/tasks.json
# - .agent-config/tasks.schema.json

# 2. (Optional) Setup sync
npm install -g @opencode/sync
opencode-sync init
opencode-sync add-adapter plane  # or jira, notion
opencode-sync start

# 3. Work
# ... agents work ...

# 4. End session
/checkpoint
```

---

## 📖 Best Practices

### 1. Always End with /checkpoint
```bash
# End of every session
/checkpoint
```

### 2. Review Before Merging
```bash
# Before merging PR
/review

# If approved
git push origin feature-branch

# If changes requested
# Fix issues...
# Then /checkpoint
```

### 3. Use /handoff for Agent Switches
```bash
# In session A (Agent: Sisyphus)
/handoff

# Start session B (Agent: Oracle)
# Paste handoff prompt

# Continue work...
```

### 4. Sync Frequently (if using)
```bash
# Start of session
/sync pull

# During work (auto-sync runs)

# End of session
/sync push
/checkpoint
```

---

## 🚫 Anti-Patterns

### ❌ Don't: Review Own Work
```bash
# WRONG:
# Agent A creates TASK-001
# Agent A runs /review (reviews own work)

# CORRECT:
# Agent A creates TASK-001, sets requires_review: true
# Agent B runs /review (reviews Agent A's work)
```

### ❌ Don't: Skip /checkpoint at Session End
```bash
# WRONG:
# Work...
# Close terminal (no checkpoint)

# CORRECT:
# Work...
# /checkpoint
# Copy handoff prompt
# Close terminal
```

### ❌ Don't: Use /checkpoint Too Often
```bash
# WRONG:
Edit file.py
/checkpoint
Edit another.py
/checkpoint
# Too many micro-commits

# CORRECT:
Edit multiple files
Complete feature
/checkpoint
```

---

## 🔗 Related Files

- **Commands**: `~/.config/opencode/command/*.md`
- **Templates**: `~/.config/opencode/templates/*.{md,json}`
- **Config**: `~/.config/opencode/{opencode.json,oh-my-opencode.json}`
- **Docs**: `~/.config/opencode/{README.md,SETUP.md,WHEN_TO_CHECKPOINT.md}`

---

## 📊 Command Comparison Table

| Command | Duration | Side Effects | Git Commit | Use Case |
|---------|----------|--------------|------------|----------|
| `/checkpoint` | 2-3min | ✅ Updates all | ✅ Yes | Session end (MANDATORY) |
| `/review` | 30-60min | ✅ Updates tasks.json | 🟡 Optional | Quality assurance |
| `/handoff` | 30s | ❌ None | ❌ No | Quick context transfer |
| `/sync` | 10-30s | ✅ Updates tasks.json | ❌ No | Ticket sync |

---

## 🆘 Troubleshooting

### "Command not found"
```bash
# Check if command exists
ls ~/.config/opencode/command/

# If missing, create from templates
# Or re-setup OpenCode config
```

### "/checkpoint doesn't generate handoff"
```bash
# This was a bug, should be fixed
# Check checkpoint.md has step 7
cat ~/.config/opencode/command/checkpoint.md | grep "Step 7"

# Should see: "7. Handoff-Prompt für nächste Session (MANDATORY)"
```

### "/sync doesn't work"
```bash
# Check if daemon running
opencode-sync status

# If not running
opencode-sync start

# Check config exists
ls .agent-config/sync.json

# If not exists
opencode-sync init
```

---

**Last Updated**: 2026-01-16
**Maintained by**: Tristan Häfele
**LinkedIn**: https://de.linkedin.com/in/tristan-wilms-812b8011b
