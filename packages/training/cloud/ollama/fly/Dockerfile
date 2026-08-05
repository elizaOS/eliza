# Self-hosted Ollama for Clawd / 8bit agent models on Fly.io.
# Models live on a persistent volume mounted at /root/.ollama.

FROM ollama/ollama:latest

ENV OLLAMA_HOST=0.0.0.0:11434
ENV OLLAMA_MODELS=/root/.ollama/models
ENV OLLAMA_KEEP_ALIVE=24h

EXPOSE 11434

# Official image entrypoint is `ollama`; CMD starts the server.
CMD ["serve"]
