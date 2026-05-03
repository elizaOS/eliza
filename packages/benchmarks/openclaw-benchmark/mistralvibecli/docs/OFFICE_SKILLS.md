# 🏢 Mistral Vibe: Office & Business Skills Guide

Dieser Guide zeigt dir die Skills für **Business, Office & Automation** (ohne Programmierung).

## 1. Dokumente & Berichte (Word / PDF)
Ideal für Verträge, Berichte, Protokolle und Korrespondenz.

| Skill | Befehl (Beispiel) | Beschreibung |
|-------|-------------------|--------------|
| `create-pdf` | "Erstelle ein PDF aus diesem Text..." | Erzeugt professionelle PDFs (mit Pandoc). |
| `anthropic-docx` | "Mach aus dem Entwurf ein Word-Doc." / "Lies den Vertrag." | Erstellt und liest .docx Dateien. |
| `anthropic-doc-coauthoring` | "Hilf mir, diesen Bericht zu verbessern." | Gemeinsames Schreiben und Überarbeiten. |

## 2. Präsentationen (PowerPoint)
Automatische Erstellung von Folien aus Daten oder Texten.

| Skill | Befehl (Beispiel) | Beschreibung |
|-------|-------------------|--------------|
| `create-pptx` | "Erstelle eine Präsentation über Q3 Zahlen." | Generiert PowerPoint (.pptx) Folien. |
| `anthropic-pptx` | "Füge eine Folie mit diesen Stichpunkten hinzu." | Bearbeitet bestehende Präsentationen. |

## 3. Excel & Datenanalyse
Ohne Formel-Chaos: Lass den Agenten deine Daten analysieren.

| Skill | Befehl (Beispiel) | Beschreibung |
|-------|-------------------|--------------|
| `anthropic-xlsx` | "Erstelle eine Excel-Tabelle mit diesen Daten." | Erzeugt komplexe Excel-Sheets. |
| `pandas` (Python) | "Finde Duplikate in dieser CSV und lösche sie." | Schnelle Datenbereinigung & Analyse. |
| `project-stats` | "Analysiere die Dateien in diesem Ordner." | Gibt Statistiken über Ordnerinhalte. |

## 4. Web Research & Content
Für Marktanalysen, Konkurrenzvergleiche und Content-Erstellung.

| Skill | Befehl (Beispiel) | Beschreibung |
|-------|-------------------|--------------|
| `firecrawl` | "Recherchiere Preise von Produkt X." | Durchsucht Webseiten (benötigt API Key). |
| `anthropic-brand-guidelines` | "Prüfe, ob der Text zu unserer Marke passt." | Checkt Tone-of-Voice und Branding. |
| `anthropic-internal-comms` | "Schreibe eine Ankündigung für das Team." | Entwürfe für Interne Kommunikation. |

## 💡 Beispiel-Workflows
Hier sind ein paar Ideen, was du direkt ausprobieren kannst:

1. **Marktanalyse & Präsentation:**
   *"Recherchiere die Top 3 Trends im Bereich [Thema] und erstelle eine kurze PowerPoint-Präsentation dazu."*

2. **Daten-Reporting:**
   *"Ich habe hier eine CSV mit Verkaufszahlen. Bitte fasse sie nach Regionen zusammen und speichere das als Excel-Bericht."*

3. **Vertrags-Check:**
   *"Lies dieses PDF (Vertrag) und fasse die wichtigsten Klauseln und Risiken zusammen."*
