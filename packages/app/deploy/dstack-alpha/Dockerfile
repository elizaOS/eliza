# syntax=docker/dockerfile:1.23
# Alpha dstack overlay on the canonical agent image (Dockerfile.ci). Both
# inputs are pinned by build-image.sh from image.lock.json.
ARG AGENT_IMAGE
ARG VERIFIER_IMAGE

FROM ${VERIFIER_IMAGE} AS verifier

FROM ${AGENT_IMAGE}
# The pinned dstack-verifier appraises this CVM's own guest evidence for the
# dstack-cpu boot gate; its digests are measured into the compose environment.
COPY --from=verifier /usr/local/bin/dstack-verifier /opt/dstack/dstack-verifier
COPY --from=verifier /etc/dstack/dstack-verifier.toml /opt/dstack/dstack-verifier.toml
COPY confidential-bootstrap.mjs alpha-entry.mjs /opt/eliza-alpha/
RUN chmod 0555 /opt/dstack/dstack-verifier \
  && chmod 0444 /opt/dstack/dstack-verifier.toml /opt/eliza-alpha/*.mjs \
  && mkdir -p /data/eliza \
  && cd /opt \
  && sha256sum dstack/dstack-verifier dstack/dstack-verifier.toml > /opt/eliza-alpha/pins.sha256 \
  && node -e 'if (process.versions.node !== "24.15.0") process.exit(1)'
