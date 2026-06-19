# We use a modern version of ubuntu as the base image because old golang images
# can cause problems with agent installations. For eg. old GLIBC versions.
_DOCKERFILE_BASE_GO = r"""
FROM --platform={platform} ubuntu:{ubuntu_version}

ARG DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt update && apt install -y \
wget \
git \
build-essential \
&& rm -rf /var/lib/apt/lists/*

# Install go. Based on https://github.com/docker-library/golang/blob/7ba64590f6cd1268b3604329ac28e5fd7400ca79/1.24/bookworm/Dockerfile
RUN set -eux; \
	now="$(date '+%s')"; \
	arch="$(dpkg --print-architecture)"; \
	url=; \
	case "$arch" in \
		'amd64') \
			url='https://dl.google.com/go/go{go_version}.linux-amd64.tar.gz'; \
			;; \
		'armhf') \
			url='https://dl.google.com/go/go{go_version}.linux-armv6l.tar.gz'; \
			;; \
		'arm64') \
			url='https://dl.google.com/go/go{go_version}.linux-arm64.tar.gz'; \
			;; \
		'i386') \
			url='https://dl.google.com/go/go{go_version}.linux-386.tar.gz'; \
			;; \
		'mips64el') \
			url='https://dl.google.com/go/go{go_version}.linux-mips64le.tar.gz'; \
			;; \
		'ppc64el') \
			url='https://dl.google.com/go/go{go_version}.linux-ppc64le.tar.gz'; \
			;; \
		'riscv64') \
			url='https://dl.google.com/go/go{go_version}.linux-riscv64.tar.gz'; \
			;; \
		's390x') \
			url='https://dl.google.com/go/go{go_version}.linux-s390x.tar.gz'; \
			;; \
		*) echo >&2 "error: unsupported architecture '$arch' (likely packaging update needed)"; exit 1 ;; \
	esac; \
	\
	wget -O go.tgz "$url" --progress=dot:giga; \
    tar -C /usr/local -xzf go.tgz; \
    rm go.tgz;
ENV PATH=/usr/local/go/bin:$PATH
RUN go version

RUN adduser --disabled-password --gecos 'dog' nonroot
"""

_DOCKERFILE_INSTANCE_GO = r"""FROM --platform={platform} {env_image_name}

COPY ./setup_repo.sh /root/
RUN /bin/bash /root/setup_repo.sh

WORKDIR /testbed/
"""
