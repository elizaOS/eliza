#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════╗
# ║  Packaging validation script — tests all packaging configs locally       ║
# ║  Run: bash packaging/test-packaging.sh                                   ║
# ╚════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

find_repo_root() {
  local dir="$1"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.github/workflows/publish-packages.yml" ]]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

REPO_ROOT="$(
  find_repo_root "$SCRIPT_DIR" ||
    git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null ||
    (
      cd "$SCRIPT_DIR/../../../.." &&
        pwd
    )
)"
PASS=0
FAIL=0
SKIP=0

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[0;33m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    green "  ✓ $name"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

check_file() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    green "  ✓ $name exists"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name missing: $path"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  local name="$1" reason="$2"
  yellow "  ○ $name (skipped: $reason)"
  SKIP=$((SKIP + 1))
}

python_has_module() {
  local module="$1"
  if ! command -v python3 &>/dev/null; then
    return 1
  fi
  python3 -c "import ${module}" >/dev/null 2>&1
}

# ── Header ───────────────────────────────────────────────────────────────────
echo ""
bold "╔══════════════════════════════════════╗"
bold "║   Packaging Validation Suite         ║"
bold "╚══════════════════════════════════════╝"
echo ""

# ── 1. PyPI Package ──────────────────────────────────────────────────────────
bold "1. PyPI Package (elizaos-app)"
if [[ ! -d "$SCRIPT_DIR/pypi" ]]; then
  skip "PyPI Package" "packaging/pypi/ directory not present in this branch"
else
check_file "pyproject.toml" "$SCRIPT_DIR/pypi/pyproject.toml"
check_file "elizaos_app/__init__.py" "$SCRIPT_DIR/pypi/elizaos_app/__init__.py"
check_file "elizaos_app/__main__.py" "$SCRIPT_DIR/pypi/elizaos_app/__main__.py"
check_file "elizaos_app/cli.py" "$SCRIPT_DIR/pypi/elizaos_app/cli.py"
check_file "elizaos_app/loader.py" "$SCRIPT_DIR/pypi/elizaos_app/loader.py"
check_file "elizaos_app/py.typed" "$SCRIPT_DIR/pypi/elizaos_app/py.typed"
check_file "README.md" "$SCRIPT_DIR/pypi/README.md"

# Validate Python syntax
if command -v python3 &>/dev/null; then
  check "Python syntax valid" python3 -c "
import ast, sys, pathlib
for f in pathlib.Path('$SCRIPT_DIR/pypi/elizaos_app').glob('*.py'):
    ast.parse(f.read_text())
"
  # Validate pyproject.toml is parseable
  check "pyproject.toml parseable" python3 -c "
import tomllib, pathlib
tomllib.loads(pathlib.Path('$SCRIPT_DIR/pypi/pyproject.toml').read_text())
"

  # Build test
  if python3 -c "import build" 2>/dev/null; then
    check "Package builds" bash -c "cd '$SCRIPT_DIR/pypi' && python3 -m build --no-isolation 2>/dev/null || python3 -m build"
  else
    skip "Package build" "python-build not installed"
  fi

  # Import test (in subprocess to avoid polluting this env)
  check "elizaos_app module importable" python3 -c "
import sys; sys.path.insert(0, '$SCRIPT_DIR/pypi')
import elizaos_app
assert elizaos_app.__version__, 'No version'
assert hasattr(elizaos_app, 'run'), 'Missing run'
assert hasattr(elizaos_app, 'ensure_runtime'), 'Missing ensure_runtime'
assert hasattr(elizaos_app, 'get_version'), 'Missing get_version'
"

  # Loader unit tests
  check "Version parser" python3 -c "
import sys; sys.path.insert(0, '$SCRIPT_DIR/pypi')
from elizaos_app.loader import _parse_version
assert _parse_version('v22.12.0') == (22, 12, 0)
assert _parse_version('v18.0.0') == (18, 0, 0)
assert _parse_version('v1.2.3-nightly') == (1, 2, 3)
assert _parse_version('not-a-version') is None
"

  check "Node detection" python3 -c "
import sys; sys.path.insert(0, '$SCRIPT_DIR/pypi')
from elizaos_app.loader import _find_node, _get_node_version
node = _find_node()
assert node, 'Node not found'
ver = _get_node_version(node)
assert ver and ver >= (22, 0, 0), f'Bad node version: {ver}'
"
else
  skip "Python tests" "python3 not available"
fi
fi  # close: if [[ -d "$SCRIPT_DIR/pypi" ]]

echo ""

# ── 2. Homebrew Formula & Cask ─────────────────────────────────────────────────
bold "2. Homebrew Formula & Cask"
check_file "elizaos-app.rb" "$SCRIPT_DIR/homebrew/elizaos-app.rb"
check_file "elizaos-app.cask.rb" "$SCRIPT_DIR/homebrew/elizaos-app.cask.rb"

# Validate Ruby syntax
if command -v ruby &>/dev/null; then
  check "Formula Ruby syntax valid" ruby -c "$SCRIPT_DIR/homebrew/elizaos-app.rb"
  check "Cask Ruby syntax valid" ruby -c "$SCRIPT_DIR/homebrew/elizaos-app.cask.rb"
else
  skip "Ruby syntax check" "ruby not available"
fi

# Check formula has real SHA256 (not placeholder)
check "Formula SHA256 is not placeholder" bash -c "! grep -q PLACEHOLDER '$SCRIPT_DIR/homebrew/elizaos-app.rb'"
check "Has url field" grep -q 'url "https://' "$SCRIPT_DIR/homebrew/elizaos-app.rb"
check "Has sha256 field" grep -q 'sha256 "' "$SCRIPT_DIR/homebrew/elizaos-app.rb"
check "Depends on node" grep -q 'depends_on "node' "$SCRIPT_DIR/homebrew/elizaos-app.rb"
check "Has test block" grep -q 'test do' "$SCRIPT_DIR/homebrew/elizaos-app.rb"

echo ""

# ── 3. Debian Packaging ─────────────────────────────────────────────────────
bold "3. Debian/apt Packaging"
check_file "debian/control" "$SCRIPT_DIR/debian/control"
check_file "debian/rules" "$SCRIPT_DIR/debian/rules"
check_file "debian/changelog" "$SCRIPT_DIR/debian/changelog"
check_file "debian/copyright" "$SCRIPT_DIR/debian/copyright"
check_file "debian/install" "$SCRIPT_DIR/debian/install"
check_file "debian/postinst" "$SCRIPT_DIR/debian/postinst"
check_file "debian/source/format" "$SCRIPT_DIR/debian/source/format"

check "rules is executable" test -x "$SCRIPT_DIR/debian/rules"
check "postinst is executable" test -x "$SCRIPT_DIR/debian/postinst"
check "Control has Package field" grep -q "^Package: elizaos-app" "$SCRIPT_DIR/debian/control"
check "Control has Depends" grep -q "Depends:" "$SCRIPT_DIR/debian/control"
check "Changelog has version" grep -q "elizaos-app (" "$SCRIPT_DIR/debian/changelog"
check "Compat level 13" grep -q "debhelper-compat (= 13)" "$SCRIPT_DIR/debian/control"
check "Source format 3.0 quilt" grep -q "3.0 (quilt)" "$SCRIPT_DIR/debian/source/format"

echo ""

# ── 4. Snap Package ─────────────────────────────────────────────────────────
bold "4. Snap Package"
check_file "snapcraft.yaml" "$SCRIPT_DIR/snap/snapcraft.yaml"

# Validate YAML syntax
if python_has_module yaml; then
  check "YAML syntax valid" python3 -c "
import yaml, pathlib
yaml.safe_load(pathlib.Path('$SCRIPT_DIR/snap/snapcraft.yaml').read_text())
"
elif command -v python3 &>/dev/null; then
  skip "YAML syntax valid" "pyyaml not installed"
fi

check "Has name field" grep -q "^name: elizaos-app" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has version field" grep -q "^version:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has confinement set" grep -q "^confinement:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has base" grep -q "^base: core22" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has apps section" grep -q "^apps:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has node part" grep -q "^  node:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has elizaos-app part" grep -q "^  elizaos-app:" "$SCRIPT_DIR/snap/snapcraft.yaml"

echo ""

# ── 5. Flatpak Package ──────────────────────────────────────────────────────
bold "5. Flatpak Package"
check_file "Flatpak manifest" "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml"
check_file "Desktop entry" "$SCRIPT_DIR/flatpak/ai.elizaos.App.desktop"
check_file "Metainfo XML" "$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml"

# Validate YAML
if python_has_module yaml; then
  check "Manifest YAML valid" python3 -c "
import yaml, pathlib
yaml.safe_load(pathlib.Path('$SCRIPT_DIR/flatpak/ai.elizaos.App.yml').read_text())
"
elif command -v python3 &>/dev/null; then
  skip "Manifest YAML valid" "pyyaml not installed"
fi

check "SHA256 not placeholder (x64)" bash -c "! grep -q PLACEHOLDER_SHA256_X64 '$SCRIPT_DIR/flatpak/ai.elizaos.App.yml'"
check "SHA256 not placeholder (arm64)" bash -c "! grep -q PLACEHOLDER_SHA256_ARM64 '$SCRIPT_DIR/flatpak/ai.elizaos.App.yml'"
check "Has app-id" grep -q "^app-id: ai.elizaos.App" "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml"
check "Has runtime" grep -q "runtime: org.freedesktop" "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml"
check "Desktop entry has Exec" grep -q "^Exec=" "$SCRIPT_DIR/flatpak/ai.elizaos.App.desktop"
check "Metainfo has app-id" grep -q "ai.elizaos.App" "$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml"

echo ""

# ── 6. CI/CD Workflow ────────────────────────────────────────────────────────
bold "6. CI/CD Workflow"
WORKFLOW="$REPO_ROOT/.github/workflows/publish-packages.yml"
check_file "publish-packages.yml" "$WORKFLOW"

if python_has_module yaml; then
  check "Workflow YAML valid" python3 -c "
import yaml, pathlib
yaml.safe_load(pathlib.Path('$WORKFLOW').read_text())
"
elif command -v python3 &>/dev/null; then
  skip "Workflow YAML valid" "pyyaml not installed"
fi

check "Has release trigger" grep -q "release:" "$WORKFLOW"
check "Has workflow_dispatch" grep -q "workflow_dispatch:" "$WORKFLOW"
check "Has PyPI job" grep -q "publish-pypi:" "$WORKFLOW"
# Homebrew is handled by the standalone update-homebrew.yml workflow
check "Has Homebrew job" test -f "$REPO_ROOT/.github/workflows/update-homebrew.yml"
check "Has Snap job" grep -q "publish-snap:" "$WORKFLOW"
check "Has Debian job" grep -q "build-deb:" "$WORKFLOW"
check "Has Flatpak job" grep -q "build-flatpak:" "$WORKFLOW"
check "Has summary job" grep -q "publish-summary:" "$WORKFLOW"
check "Uses trusted publishing" grep -q "id-token: write" "$WORKFLOW"

echo ""

# ── 7. Publishing Guide ─────────────────────────────────────────────────────
bold "7. Publishing Guide"
check_file "PUBLISHING_GUIDE.md" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers PyPI" grep -q "PyPI" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers Homebrew" grep -q "Homebrew" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers apt" grep -q "apt" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers Snap" grep -q "Snap" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers Flatpak" grep -q "Flatpak" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Has version checklist" grep -q "Version Bumping" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
bold "════════════════════════════════════════"
bold "  Results: $(green "$PASS passed"), $(red "$FAIL failed"), $(yellow "$SKIP skipped")"
bold "════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
