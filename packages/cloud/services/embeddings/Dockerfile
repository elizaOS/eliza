# Reproducible build of the self-hosted embeddings sidecar behind the cloud-api
# /api/v1/embeddings route (the LOCAL_EMBEDDINGS_BASE_URL branch in
# packages/cloud/shared/src/lib/providers/language-model.ts). It wraps the
# upstream HuggingFace text-embeddings-inference (TEI) image, which natively
# serves an OpenAI-compatible /v1/embeddings surface, so the deploy is a pinned
# in-repo artifact rather than a hand-provisioned pet.
#
# Contract this image MUST satisfy (the Worker routing depends on it):
#   POST /v1/embeddings  { input, model } -> OpenAI-compatible embedding list
#        (BAAI/bge-small-en-v1.5 -> 384-dim vectors; the `model` field is
#        accepted and ignored — TEI embeds with its one loaded model)
#   GET  /health         -> 200 once the model is loaded (Railway healthcheck,
#        see railway.toml)
#
# Pin: TEI publishes CPU/CUDA variants under
# ghcr.io/huggingface/text-embeddings-inference. CPU is the Railway default
# (no GPU on the default plan); override TEI_IMAGE at build time for a CUDA
# variant on a GPU-backed plan. Prefer pinning a concrete tag on deploy —
# cpu-latest is the documented default, but bump deliberately and verify the
# ghcr manifest still serves /v1/embeddings and /health before shipping.
ARG TEI_IMAGE=ghcr.io/huggingface/text-embeddings-inference:cpu-latest

FROM ${TEI_IMAGE}

# The Worker's local id "bge-small-en-v1.5" (KNOWN_EMBEDDING_DIMENSIONS: 384)
# maps to this HuggingFace repo. TEI downloads the model from the HF hub into
# HUGGINGFACE_HUB_CACHE (/data in the upstream image) on first boot — attach a
# Railway volume at /data to persist it across restarts, or accept the small
# (~130MB) re-download; railway.toml's healthcheckTimeout budgets for it.
ARG EMBEDDINGS_MODEL=BAAI/bge-small-en-v1.5
ENV MODEL_ID=${EMBEDDINGS_MODEL}

# Railway replaces this default with its deployment-specific PORT; TEI's router
# reads the PORT env natively, so the healthcheck and public traffic always
# probe the same socket. The upstream ENTRYPOINT (text-embeddings-router)
# is inherited unchanged.
ENV PORT=3000
EXPOSE 3000
