# Isolierte Benchmark-Umgebung für Oh My OpenCode
FROM node:20-slim

# Labels für eindeutige Identifikation
LABEL project="benchmark" \
      component="ohmyopencode" \
      purpose="benchmark" \
      maintainer="coding_template"

# Basis-Tools installieren
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    bc \
    && rm -rf /var/lib/apt/lists/*

# OpenCode installieren (Basis)
COPY --from=ghcr.io/anomalyco/opencode /usr/local/bin/opencode /usr/local/bin/opencode

# Oh My OpenCode installieren
RUN npm install -g oh-my-opencode

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
    echo 'echo "⚡ AGENT BENCHMARK: Oh My OpenCode"' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 SETUP:"' >> /root/.bashrc && \
    echo 'echo "   oh-my-opencode install    # Plugin installieren"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 TESTEN:"' >> /root/.bashrc && \
    echo 'echo "   opencode                  # OpenCode mit Oh My starten"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc

CMD ["bash"]
