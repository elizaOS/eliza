# Isolierte Benchmark-Umgebung für OpenClaw mit Sandboxing
# Wir nutzen ein Debian Image (Bookworm) und installieren Docker manuell,
# da Alpine (docker:dind) Probleme mit native Modules (node-llama-cpp) macht.
FROM node:22-bookworm

# Labels für eindeutige Identifikation
LABEL project="benchmark" \
      component="openclaw" \
      purpose="benchmark" \
      maintainer="coding_template"

# Docker & Tools installieren (auf Debian Basis)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    git \
    jq \
    python3 \
    make \
    g++ \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
      "deb [arch=\"$(dpkg --print-architecture)\" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
      $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-ce containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Dockerd Entrypoint Script simulieren/kopieren
# Wir starten dockerd im Hintergrund via CMD

# OpenClaw global installieren
RUN npm install -g openclaw@latest

# OpenClaw Sandbox-Konfiguration kopieren
# Aktiviert Docker-Sandboxing für alle Sessions
COPY openclaw.config.json /root/.openclaw/config.json

# Arbeitsverzeichnis erstellen
WORKDIR /workspace

# Standard-Benchmark PRD kopieren
COPY standard_tasks.md /workspace/PRD.md

# Start-Message
RUN echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo "🦀 AGENT BENCHMARK: OpenClaw (Sandboxed)"' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "🔒 SANDBOX: Alle Tool-Executions laufen in Docker-Containern"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 SETUP:"' >> /root/.bashrc && \
    echo 'echo "   openclaw onboard    # Konfiguration starten"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "📋 TESTEN:"' >> /root/.bashrc && \
    echo 'echo "   openclaw \"Erstelle weather.js laut PRD.md\""' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc && \
    echo 'echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"' >> /root/.bashrc && \
    echo 'echo ""' >> /root/.bashrc

# Docker Daemon im Hintergrund starten & Shell öffnen
CMD ["sh", "-c", "dockerd > /var/log/dockerd.log 2>&1 & sleep 3 && bash"]
