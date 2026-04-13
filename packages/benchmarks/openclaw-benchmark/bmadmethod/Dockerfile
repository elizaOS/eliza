# Isolierte Benchmark-Umgebung für BMAD-METHOD
FROM node:20-slim

# Labels für eindeutige Identifikation
LABEL project="benchmark" \
      component="bmadmethod" \
      purpose="benchmark" \
      maintainer="coding_template"

# Basis-Tools installieren
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    bc \
    && rm -rf /var/lib/apt/lists/*

# OpenCode installieren (Basis für BMAD Agenten)
RUN npm install -g opencode

# BMAD-METHOD installieren
RUN npx -y bmad-method@latest --help || true

# Langfuse-Plugin für Token-Tracking
RUN npm install -g opencode-plugin-langfuse

# OpenCode-Konfiguration mit Langfuse und OpenTelemetry
RUN mkdir -p /root/.config/opencode && \
    echo '{"plugin": ["opencode-plugin-langfuse"], "experimental": {"openTelemetry": true}}' > /root/.config/opencode/opencode.json

# Arbeitsverzeichnis erstellen
WORKDIR /workspace

# Standard-Benchmark PRD kopieren
COPY standard_tasks.md /workspace/PRD.md

# Start-Message in .bashrc einfügen
RUN echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo "🚀 AGENT BENCHMARK: BMAD-METHOD"' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 SETUP:"' >> /root/.bashrc && \
    echo 'echo "   npx bmad-method init    # Projekt initialisieren"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 TESTEN:"' >> /root/.bashrc && \
    echo 'echo "   npx bmad-method dev     # BMAD Workflow starten"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc

CMD ["bash"]
