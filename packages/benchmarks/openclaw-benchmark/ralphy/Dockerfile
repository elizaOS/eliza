# Isolierte Testumgebung für Ralphy CLI mit OpenCode
FROM node:20-slim

# Labels für eindeutige Identifikation
LABEL project="benchmark" \
      component="ralphy" \
      purpose="benchmark" \
      maintainer="coding_template"

# Basis-Tools installieren
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    bc \
    && rm -rf /var/lib/apt/lists/*

# Ralphy CLI global installieren
RUN npm install -g ralphy-cli

# OpenCode sauber installieren (via offiziellem Installer)
COPY --from=ghcr.io/anomalyco/opencode /usr/local/bin/opencode /usr/local/bin/opencode

# Langfuse-Plugin & Antigravity Auth installieren
RUN npm install -g opencode-plugin-langfuse opencode-antigravity-auth

# OpenCode-Konfiguration mit Langfuse, OpenTelemetry und Antigravity Auth
RUN mkdir -p /root/.config/opencode && \
    echo '{"plugin": ["opencode-plugin-langfuse", "opencode-antigravity-auth"], "experimental": {"openTelemetry": true}}' > /root/.config/opencode/opencode.json

# Arbeitsverzeichnis erstellen
WORKDIR /workspace

# Standard-Benchmark PRD kopieren
COPY standard_tasks.md /workspace/PRD.md

# Start-Message in .bashrc einfügen (wird bei jedem Bash-Start angezeigt)
RUN echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo "🚀 OPENCODE PLUGIN TEST: Ralphy"' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "OpenCode nutzt Default-Modelle (big-pickle, etc.)"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 TESTEN:"' >> /root/.bashrc && \
    echo 'echo "   opencode                          # OpenCode starten"' >> /root/.bashrc && \
    echo 'echo "   ralphy --opencode \"add feature\"   # Ralphy mit OpenCode"' >> /root/.bashrc && \
    echo 'echo "   ralphy --opencode --prd PRD.md    # PRD abarbeiten"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc

# Direkt Bash starten
CMD ["bash"]
