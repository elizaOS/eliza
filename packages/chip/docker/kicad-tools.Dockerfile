FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    make \
    python3 \
    python3-pip \
    python3-venv \
    kicad \
    kicad-libraries \
    kicad-footprints \
    kicad-symbols \
    kicad-templates \
    kicad-packages3d \
    xvfb \
    imagemagick \
    librsvg2-bin \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv --system-site-packages /opt/kicad-tools-venv \
    && /opt/kicad-tools-venv/bin/pip install --upgrade pip \
    && /opt/kicad-tools-venv/bin/pip install kibot pcbdraw pillow pyyaml

ENV PATH="/opt/kicad-tools-venv/bin:${PATH}"

WORKDIR /work
