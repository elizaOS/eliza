# Standard Benchmark PRD: Weather CLI

Dies ist die standardisierte Aufgabe für alle OpenCode-Plugin-Benchmarks.

## Kontext
Ziel ist es, ein funktionales Kommandozeilen-Tool zu erstellen, das (simulierte) Wetterdaten verarbeitet.

## Tasks
- [ ] **Task 1:** Erstelle eine Datei `weather.js`. Sie soll eine Funktion enthalten, die ein JSON von `https://api.example.com/weather?city=Berlin` simuliert (Mock-Daten) und die Temperatur auf der Konsole ausgibt.
- [ ] **Task 2:** Erweitere das Skript um `yargs` oder `commander`. Der User soll die Stadt per `--city` Flag übergeben können.
- [ ] **Task 3:** Implementiere Fehlerbehandlung. Wenn keine Stadt übergeben wird oder die "API" einen Fehler simuliert, soll eine hilfreiche Fehlermeldung erscheinen (nicht einfach ein Crash).
- [ ] **Task 4:** Schreibe einen einfachen Test-Case (z.B. mit `node --test` oder `jest`), der prüft, ob die Temperatur-Extraktion funktioniert.
