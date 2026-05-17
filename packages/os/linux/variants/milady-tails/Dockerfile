# elizaOS Live ISO builder — containerized, OS-agnostic
#
# Replaces Tails' Vagrant+libvirt build VM with a plain container.
# Any host with Docker (Linux / macOS / Windows / CI) builds the same
# ISO from the same builder image. Run --privileged: live-build does
# chroot, mount, loop-device, and debootstrap operations.
#
# Build:  docker build -t elizaos-tails-builder .
# Run:    docker run --rm --privileged \
#           -v <tails-source>:/build \
#           -v <output-dir>:/out \
#           elizaos-tails-builder
#
# Tails targets Debian Trixie; match the base image to minimise the
# arg-translation surface against Tails' config/. Pinned by digest so
# the builder image is reproducible — `debian:trixie` is a moving tag.
# Bump deliberately. (ISO *content* reproducibility comes separately
# from Tails' dated APT snapshot mirrors.)
FROM debian:trixie@sha256:e2d08da6f42ef4b09b165d55528a12727aeed8240dc9edf888e3ec07e10ef9da

# Don't prompt during apt operations inside the build
ENV DEBIAN_FRONTEND=noninteractive

# ── Build dependencies ───────────────────────────────────────────────
# This mirrors the package set Tails installs in its own builder box
# (vagrant/definitions/tails-builder/generate-tails-builder-box.sh) —
# minus the VM-orchestration layer (vagrant, vagrant-libvirt, libvirt,
# dnsmasq-base, ebtables, vmdb2, openssh-server, linux-image-amd64,
# qemu-guest-agent, ifupdown, isc-dhcp-client) because the container
# IS the build environment, so it needs no VM, no SSH, no guest kernel.
#
#   live-build's own runtime deps:
#     debootstrap, cpio, dosfstools, mtools, parted, squashfs-tools,
#     xorriso, syslinux + isolinux, grub, rsync
#   Tails' build-script deps:
#     psmisc, git, dpkg-dev, rake, faketime, jq, pigz, qemu-utils,
#     ruby, python3, gnupg, xz-utils, zstd, ca-certificates, sudo,
#     gdisk, lsof, time, wget, curl, make, iproute2, python3-gi
#   Tails' website build (./build-website → ikiwiki) deps:
#     ikiwiki (from forky — see below), po4a, intltool, gettext,
#     libfile-slurp-perl, libimage-magick-perl, liblist-moreutils-perl,
#     libtimedate-perl, libyaml-syck-perl
#   apt-cacher-ng: required, not optional — Tails' chroot hooks run
#     apt inside a chroot whose resolv.conf is Tor-only (dead at build
#     time). apt reaches packages via this proxy by IP. See acng.conf.
RUN apt-get update && apt-get install -y --no-install-recommends \
        debootstrap \
        cpio \
        dosfstools \
        mtools \
        parted \
        squashfs-tools \
        xorriso \
        isolinux \
        syslinux \
        syslinux-common \
        grub-pc-bin \
        grub-efi-amd64-bin \
        grub2-common \
        rsync \
        psmisc \
        git \
        dpkg-dev \
        rake \
        ruby \
        faketime \
        jq \
        pigz \
        qemu-utils \
        python3 \
        python3-yaml \
        python3-gi \
        gnupg \
        xz-utils \
        zstd \
        ca-certificates \
        sudo \
        file \
        procps \
        apt-cacher-ng \
        gdisk \
        lsof \
        time \
        wget \
        curl \
        make \
        iproute2 \
        po4a \
        intltool \
        gettext \
        libfile-slurp-perl \
        libimage-magick-perl \
        liblist-moreutils-perl \
        libtimedate-perl \
        libyaml-syck-perl \
    && rm -rf /var/lib/apt/lists/*

# ── ikiwiki from Debian forky ────────────────────────────────────────
# Tails' ./build-website drives ikiwiki with its own ikiwiki.setup,
# which needs a newer ikiwiki than Trixie ships. Tails' builder box
# pins ikiwiki from forky (commit "Upgrade po4a to Trixie and ikiwiki
# to Forky"); we replicate that pin exactly: forky is added as a source
# but pinned to priority 1 (effectively off) so ONLY ikiwiki — pinned
# 1000 — is pulled from it. Everything else stays on Trixie.
RUN printf 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: forky\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.pgp\n' \
        > /etc/apt/sources.list.d/forky.sources \
    && printf 'Package: *\nPin: release n=forky\nPin-Priority: 1\n' \
        > /etc/apt/preferences.d/forky \
    && printf 'Package: ikiwiki\nPin: release n=forky\nPin-Priority: 1000\n' \
        > /etc/apt/preferences.d/ikiwiki \
    && apt-get update \
    && apt-get install -y --no-install-recommends ikiwiki \
    && rm -rf /var/lib/apt/lists/*

# ── Install Tails' live-build fork ───────────────────────────────────
# Tails pins its own live-build fork (submodules/live-build, branch
# tails/debian-old-2.0). Modern Debian live-build rejects Tails'
# `lb config` arguments (--volatile, --includes, --packages-lists,
# --syslinux-*, etc.), so we MUST install Tails' fork, not the distro
# package. The Makefile install target lays it down at
# /usr/share/live/build/ + /usr/bin/lb — exactly where Tails' auto/
# scripts expect it.
#
# The submodule is COPY'd in at build time (it's ~19 MB of scripts,
# fine to bake into the image). The rest of the Tails source is
# mounted at runtime so edits are live and we don't bake 77 MB of
# config into an image layer.
COPY tails-live-build/ /opt/tails-live-build/
RUN cd /opt/tails-live-build \
    && make install DESTDIR=/ \
    && rm -rf /opt/tails-live-build \
    && lb --version

# ── apt-cacher-ng config ─────────────────────────────────────────────
# Our acng.conf (derived from Tails' own) replaces the package default.
# The package's debconf-managed zz_debconf.conf would otherwise re-set
# CacheDir/Port from debconf answers we never gave — drop it so only
# our config is authoritative. The cache itself lives on a Docker named
# volume mounted at /var/cache/apt-cacher-ng (see build.sh).
COPY acng.conf /etc/apt-cacher-ng/acng.conf
RUN rm -f /etc/apt-cacher-ng/zz_debconf.conf

# ── Entry point ──────────────────────────────────────────────────────
# build-iso.sh runs Tails' own auto/config && auto/build inside the
# mounted source tree and copies the resulting ISO to /out.
COPY build-iso.sh /usr/local/bin/build-iso.sh
RUN chmod +x /usr/local/bin/build-iso.sh

# /build = the Tails source tree (mounted at runtime, rw — lb writes
#          chroot/, binary/, cache/ into it)
# /out   = where the finished ISO lands (mounted at runtime)
WORKDIR /build
ENTRYPOINT ["/usr/local/bin/build-iso.sh"]
