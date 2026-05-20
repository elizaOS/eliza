# Base image pinned by digest for reproducibility. Refresh with:
#   docker manifest inspect --verbose ubuntu:24.04 | jq -r '.Descriptor.digest // .manifests[0].digest'
# or the registry HTTP API (Accept: application/vnd.docker.distribution.manifest.v2+json
# against registry-1.docker.io/v2/library/ubuntu/manifests/24.04) and update
# docs/toolchain/reproducibility.md in lockstep.
ARG UBUNTU_DIGEST=sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b
FROM ubuntu:24.04@${UBUNTU_DIGEST}

ENV DEBIAN_FRONTEND=noninteractive

# Capture an apt manifest archive so the exact resolved package set for this
# image build is reproducible from a single artifact. The archive is consumed
# by scripts/record_tool_versions.sh and docs/toolchain/reproducibility.md.
RUN set -eux; \
    mkdir -p /var/log/apt-manifest; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl git make cmake ninja-build \
        bc bison flex file pkg-config rsync unzip \
        python3 python3-dev python3-pip python3-venv \
        shellcheck jq device-tree-compiler \
        verilator yosys iverilog gtkwave qemu-system-misc \
        gcc-riscv64-unknown-elf gcc-riscv64-linux-gnu z3 \
        openjdk-17-jdk-headless repo adb \
        fio openocd sigrok-cli \
        klayout magic netgen \
        nextpnr-ecp5 fpga-icestorm kicad; \
    dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' \
        > /var/log/apt-manifest/installed-packages.tsv; \
    apt-cache policy > /var/log/apt-manifest/apt-policy.txt 2>&1 || true; \
    cp /etc/apt/sources.list /var/log/apt-manifest/sources.list 2>/dev/null || true; \
    if [ -d /etc/apt/sources.list.d ]; then \
        tar -C /etc/apt -cf /var/log/apt-manifest/sources.list.d.tar sources.list.d 2>/dev/null || true; \
    fi; \
    rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/eliza-venv
ENV PATH="/opt/eliza-venv/bin:${PATH}"
COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip && pip install -r /tmp/requirements.txt

WORKDIR /work
