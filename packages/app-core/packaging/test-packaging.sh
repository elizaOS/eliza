#!/usr/bin/env bash
# Validates package manifests and release workflows without generating or
# publishing distribution artifacts. Environment-only checks report a skip so
# missing local tooling or generated payloads cannot masquerade as proof.
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

runtime_has_no_bundled_media_executables() {
  local runtime_root="$1"
  local bundled_media_bin
  [[ -d "$runtime_root" ]] || return 1
  if ! bundled_media_bin="$({
    find "$runtime_root" \
      \( -type f -o -type l \) \
      \( -name ffmpeg -o -name ffmpeg.exe -o -name ffprobe -o -name ffprobe.exe \) \
      -print -quit
  })"; then
    return 1
  fi
  [[ -z "$bundled_media_bin" ]]
}

workflow_prepares_locked_debian_node() {
  local workflow="$1"
  local runtime_line node_line
  runtime_line="$(
    grep -n -- '--destination-root packages/app-core/packaging/debian/runtime' "$workflow" |
      cut -d: -f1
  )" || return 1
  node_line="$(
    grep -n 'packages/scripts/locked-node-runtime.mjs' "$workflow" |
      cut -d: -f1
  )" || return 1
  [[ "$runtime_line" =~ ^[0-9]+$ ]] || return 1
  [[ "$node_line" =~ ^[0-9]+$ ]] || return 1
  ((node_line > runtime_line)) || return 1
  # The prepare step lists one --stub flag per license-stubbed package
  # between the destination and the Node provisioning step.
  ((node_line - runtime_line <= 16)) || return 1
  [[ "$(grep -c 'packages/scripts/locked-node-runtime.mjs' "$workflow")" -eq 1 ]]
}

workflow_avoids_host_node_dependency() {
  local workflow="$1"
  [[ -f "$workflow" ]] || return 1
  if grep -Fq 'deb.nodesource.com' "$workflow"; then
    return 1
  fi
  if grep -Fq 'nodejs=' "$workflow"; then
    return 1
  fi
  ! grep -Fq 'apt-cache madison nodejs' "$workflow"
}

workflow_proves_bundled_debian_node() {
  local workflow="$1"
  grep -Fq 'BUNDLED_NODE=/usr/lib/elizaos-app/node/bin/node' "$workflow" || return 1
  grep -Fq '"v24.15.0"' "$workflow" || return 1
  grep -Fq 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c' "$workflow" || return 1
  grep -Fq '/usr/lib/elizaos-app/node/LICENSE' "$workflow" || return 1
  grep -Fq '/usr/lib/elizaos-app/node/elizaos-runtime-provenance.json' "$workflow" || return 1
  grep -Fq 'cmp /usr/lib/elizaos-app/node/LICENSE' "$workflow" || return 1
  grep -Fq 'cmp /usr/lib/elizaos-app/node/elizaos-runtime-provenance.json' "$workflow" || return 1
  grep -Fq '/usr/share/doc/elizaos-app/elizaos-LICENSE' "$workflow" || return 1
  grep -Fq '/usr/share/doc/elizaos-app/third-party-notices.json' "$workflow" || return 1
  grep -Fq 'cmp /usr/lib/elizaos-app/THIRD_PARTY_NOTICES.json' "$workflow" || return 1
  grep -Fq 'inventory.packageCount !== inventory.packages.length' "$workflow" || return 1
  grep -Fq '/usr/lib/elizaos-app/node/include/node/node.h' "$workflow" || return 1
  grep -Fq '/usr/lib/elizaos-app/node/lib/node_modules/npm/package.json' "$workflow" || return 1
  grep -Fq 'Debian package unexpectedly depends on host nodejs' "$workflow" || return 1
  grep -Fq 'Debian shared-library dependencies were not derived' "$workflow" || return 1
  grep -Fq 'PATH=/nonexistent /usr/bin/elizaos-app --version' "$workflow" || return 1
  grep -Fq 'export PATH=/usr/lib/elizaos-app/node/bin:$PATH' "$workflow" || return 1
  grep -Fq -- '-- /usr/bin/elizaos-app' "$workflow"
}

workflow_generates_runtime_license_inventory() {
  local workflow="$1"
  local prepare_count inventory_count
  local -a prepare_lines inventory_lines
  prepare_count="$(grep -c 'packages/scripts/prepare-packaged-runtime.mjs' "$workflow")"
  inventory_count="$(grep -c 'packages/app-core/packaging/generate-license-inventory.mjs' "$workflow")"
  ((prepare_count > 0)) || return 1
  ((inventory_count == prepare_count)) || return 1
  mapfile -t prepare_lines < <(
    grep -n 'packages/scripts/prepare-packaged-runtime.mjs' "$workflow" | cut -d: -f1
  )
  mapfile -t inventory_lines < <(
    grep -n 'packages/app-core/packaging/generate-license-inventory.mjs' "$workflow" | cut -d: -f1
  )
  for index in "${!prepare_lines[@]}"; do
    ((inventory_lines[index] > prepare_lines[index])) || return 1
    ((inventory_lines[index] - prepare_lines[index] <= 20)) || return 1
  done
}

workflow_copies_only_debian_metadata() {
  local workflow="$1"
  grep -Fq 'git archive --format=tar HEAD packages/app-core/packaging/debian' "$workflow" || return 1
  grep -Fq 'tar --extract --directory=debian --strip-components=4' "$workflow" || return 1
  grep -Fq 'test ! -e debian/runtime' "$workflow" || return 1
  grep -Fq 'test ! -e debian/node-runtime' "$workflow" || return 1
  ! grep -Fq 'cp -r packages/app-core/packaging/debian .' "$workflow"
}

pypi_workflow_uses_locked_build_tools() {
  local workflow="$1"
  local build_count lock_count artifact_check_count build_line
  build_count="$(grep -c 'python -m build ' "$workflow")"
  lock_count="$(grep -c -- '--requirement build-requirements.lock' "$workflow")"
  artifact_check_count="$(grep -c 'python verify_artifacts.py ' "$workflow")"
  ((build_count > 0)) || return 1
  ((lock_count >= build_count)) || return 1
  ((artifact_check_count == build_count)) || return 1
  while IFS= read -r build_line; do
    [[ "$build_line" == *"--no-isolation"* ]] || return 1
  done < <(grep 'python -m build ' "$workflow")
}

workflow_installs_python_packages_from_reviewed_sources() {
  local workflow="$1"
  python3 - "$workflow" <<'PY'
import pathlib
import re
import sys

workflow = pathlib.Path(sys.argv[1])
text = workflow.read_text()
logical = re.sub(r"\\\s*\n\s*", " ", text)
commands = re.findall(
    r"(?im)^[ \t]*(?:(?:python(?:3)?)[ \t]+-m[ \t]+)?pip(?:3)?[ \t]+install\b[^\n]*",
    logical,
)
assert commands, f"no pip install commands found in {workflow}"
for command in commands:
    uses_reviewed_lock = (
        "--require-hashes" in command
        and "--requirement build-requirements.lock" in command
    )
    installs_built_wheel = "--no-deps" in command and "wheels[0]" in command
    assert uses_reviewed_lock or installs_built_wheel, (
        f"unreviewed pip install in {workflow}: {command.strip()}"
    )
PY
}

apt_publish_validates_artifact_before_reprepro() {
  local workflow="$1"
  local validation_line reprepro_line
  validation_line="$(grep -n 'name: Validate downloaded Debian artifact' "$workflow" | cut -d: -f1)" || return 1
  reprepro_line="$(grep -n 'name: Add .deb to reprepro' "$workflow" | cut -d: -f1)" || return 1
  [[ "$validation_line" =~ ^[0-9]+$ ]] || return 1
  [[ "$reprepro_line" =~ ^[0-9]+$ ]] || return 1
  ((validation_line < reprepro_line)) || return 1
  grep -Fq 'EXPECTED_DEBIAN_VERSION="${RELEASE_VERSION/-beta./~beta}"' "$workflow" || return 1
  grep -Fq 'EXPECTED_DEBIAN_VERSION="${EXPECTED_DEBIAN_VERSION/-rc./~rc}-1"' "$workflow" || return 1
  grep -Fq 'dpkg-deb --field "$DEB_PATH" Package' "$workflow" || return 1
  grep -Fq 'dpkg-deb --field "$DEB_PATH" Architecture' "$workflow" || return 1
  grep -Fq 'dpkg-deb --field "$DEB_PATH" Version' "$workflow" || return 1
  grep -Fq '[[ "$PACKAGE_NAME" != "elizaos-app" ]]' "$workflow" || return 1
  grep -Fq '[[ "$PACKAGE_ARCHITECTURE" != "amd64" ]]' "$workflow"
}

apt_publish_has_guarded_teardown() {
  local workflow="$1"
  grep -Fq 'PUBLISH_ROOT="$RUNNER_TEMP/elizaos-apt-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${GITHUB_JOB}"' "$workflow" || return 1
  grep -Fq 'echo "APT_PUBLISH_ROOT=$PUBLISH_ROOT"' "$workflow" || return 1
  grep -A24 'name: Remove isolated publishing state' "$workflow" |
    grep -Fq 'if: always()' || return 1
  grep -A24 'name: Remove isolated publishing state' "$workflow" |
    grep -Fq 'error-policy:J6' || return 1
  grep -A24 'name: Remove isolated publishing state' "$workflow" |
    grep -Fq 'APT_PUBLISH_ROOT="${APT_PUBLISH_ROOT:-$EXPECTED_ROOT}"' || return 1
  grep -A24 'name: Remove isolated publishing state' "$workflow" |
    grep -Fq 'APT_PUBLISH_ROOT" != "$EXPECTED_ROOT' || return 1
  grep -A24 'name: Remove isolated publishing state' "$workflow" |
    grep -Fq 'rm -rf -- "$APT_PUBLISH_ROOT"'
}

apt_publish_primes_signer_and_reexports() {
  local workflow="$1"
  grep -Fq 'printf '\''%s'\'' "$DEBIAN_GPG_PASSPHRASE"' "$workflow" || return 1
  grep -Fq -- '--pinentry-mode loopback --passphrase-fd 0' "$workflow" || return 1
  grep -Fq -- '--local-user "$DEBIAN_GPG_FINGERPRINT!"' "$workflow" || return 1
  grep -q '^[[:space:]]*reprepro export[[:space:]]*$' "$workflow" || return 1
  ! grep -Fq -- '--ask-passphrase' "$workflow"
}

apt_publish_is_byte_idempotent() {
  local workflow="$1"
  grep -Fq 'PACKAGE_LIST="$(' "$workflow" || return 1
  grep -Fq 'MATCHING_PACKAGE_FILES="$(' "$workflow" || return 1
  grep -Fq -- '--list-format '\''${package}\t${version}\t${$architecture}\t${$fullfilename}\n'\''' "$workflow" || return 1
  grep -Fq '[[ "${#EXISTING_PACKAGE_FILES[@]}" -gt 1 ]]' "$workflow" || return 1
  grep -Fq 'EXISTING_PACKAGE="$(realpath -- "${EXISTING_PACKAGE_FILES[0]}")"' "$workflow" || return 1
  grep -Fq 'EXISTING_SHA256="$(sha256sum "$EXISTING_PACKAGE"' "$workflow" || return 1
  grep -Fq 'DOWNLOADED_SHA256="$(sha256sum "$DEB_PATH"' "$workflow" || return 1
  grep -Fq 'with different bytes' "$workflow"
}

release_distribution_has_single_package_owner() {
  local workflows="$REPO_ROOT/.github/workflows"
  local build_debian="$workflows/build-debian-package.yml"
  local packages="$workflows/publish-packages.yml"
  local flathub="$workflows/flatpak-publish.yml"

  # build-debian-package.yml is a build+smoke gate: it must never attach
  # release assets itself. Attachment lives only in publish-packages.yml,
  # after the installed smoke passes.
  grep -q '^  workflow_call:' "$build_debian" || return 1
  grep -q '^  workflow_dispatch:' "$build_debian" || return 1
  ! grep -q '^  release:' "$build_debian" || return 1
  ! grep -Fq 'softprops/action-gh-release' "$build_debian" || return 1

  grep -Fq 'Attach .deb to GitHub Release' "$packages" || return 1
  [[ "$(grep -c '^  publish-apt:' "$packages")" -eq 1 ]] || return 1
  [[ "$(grep -c '^  publish-snap:' "$packages")" -eq 1 ]] || return 1

  # flatpak-publish.yml never submits to Flathub; it delegates to the
  # verified publish-packages.yml side-load bundle job.
  grep -Fq 'uses: ./.github/workflows/publish-packages.yml' "$flathub" || return 1
  ! grep -Eq 'gh repo fork|gh pr create|FLATHUB_TOKEN' "$flathub"
}

release_debian_attachment_is_byte_idempotent() {
  local workflow="$1"
  grep -Fq 'EXISTING_DEB_NAMES="$(' "$workflow" || return 1
  grep -Fq 'gh release download "$TAG"' "$workflow" || return 1
  grep -Fq 'RELEASE_SHA256="$(sha256sum "$DOWNLOADED_DEB"' "$workflow" || return 1
  grep -Fq 'already contains $LOCAL_NAME with different bytes' "$workflow" || return 1
  grep -Fq 'already contains the byte-identical $LOCAL_NAME' "$workflow" || return 1
  grep -Fq 'gh release upload "$TAG" "$LOCAL_DEB"' "$workflow" || return 1
  ! grep -Fq 'gh release upload "$TAG" "${main_debs[0]}" --clobber' "$workflow"
}

release_flatpak_attachment_is_byte_idempotent() {
  local workflow="$1"
  grep -Fq 'EXISTING_BUNDLE_NAMES="$(' "$workflow" || return 1
  grep -Fq 'gh release download "$TAG"' "$workflow" || return 1
  grep -Fq 'RELEASE_SHA256="$(sha256sum "$DOWNLOADED_BUNDLE"' "$workflow" || return 1
  grep -Fq 'already contains $BUNDLE_NAME with different bytes' "$workflow" || return 1
  grep -Fq 'already contains the byte-identical $BUNDLE_NAME' "$workflow" || return 1
  grep -Fq 'gh release upload "$TAG" "$LOCAL_BUNDLE"' "$workflow" || return 1
  ! grep -Fq -- '--clobber' "$workflow"
}

workflow_triggers_packaging_validator() {
  local workflow_name="$1"
  local validator="$REPO_ROOT/.github/workflows/test-packaging.yml"
  [[ "$(grep -Fc "      - '.github/workflows/$workflow_name'" "$validator")" -eq 2 ]]
}

# ── Header ───────────────────────────────────────────────────────────────────
echo ""
bold "╔══════════════════════════════════════╗"
bold "║   Packaging Validation Suite         ║"
bold "╚══════════════════════════════════════╝"
echo ""

# ── 1. PyPI Package ──────────────────────────────────────────────────────────
bold "1. PyPI Package (elizaos-app)"
check_file "pyproject.toml" "$SCRIPT_DIR/pypi/pyproject.toml"
check_file "elizaos_app/__init__.py" "$SCRIPT_DIR/pypi/elizaos_app/__init__.py"
check_file "elizaos_app/__main__.py" "$SCRIPT_DIR/pypi/elizaos_app/__main__.py"
check_file "elizaos_app/cli.py" "$SCRIPT_DIR/pypi/elizaos_app/cli.py"
check_file "elizaos_app/loader.py" "$SCRIPT_DIR/pypi/elizaos_app/loader.py"
check_file "loader failure tests" "$SCRIPT_DIR/pypi/test_loader.py"
check_file "elizaos_app/py.typed" "$SCRIPT_DIR/pypi/elizaos_app/py.typed"
check_file "README.md" "$SCRIPT_DIR/pypi/README.md"
check_file "LICENSE" "$SCRIPT_DIR/pypi/LICENSE"
check_file "build requirements input" "$SCRIPT_DIR/pypi/build-requirements.in"
check_file "hashed build requirements lock" "$SCRIPT_DIR/pypi/build-requirements.lock"
check_file "artifact license verifier" "$SCRIPT_DIR/pypi/verify_artifacts.py"
check "PyPI LICENSE is byte-identical to repository LICENSE" \
  cmp -s "$REPO_ROOT/LICENSE" "$SCRIPT_DIR/pypi/LICENSE"

# Validate Python syntax
if command -v python3 &>/dev/null; then
  check "Python syntax valid" python3 -c "
import ast, sys, pathlib
for f in pathlib.Path('$SCRIPT_DIR/pypi/elizaos_app').glob('*.py'):
    ast.parse(f.read_text())
"
  check "Node probe timeout is translated to a typed failure" \
    bash -c "cd '$SCRIPT_DIR/pypi' && python3 -m unittest -v test_loader.py"
  # Validate pyproject.toml is parseable
  check "pyproject.toml parseable" python3 -c "
import tomllib, pathlib
tomllib.loads(pathlib.Path('$SCRIPT_DIR/pypi/pyproject.toml').read_text())
"

  check "PyPI build backend and license metadata are exact" python3 -c "
import pathlib, tomllib
config = tomllib.loads(pathlib.Path('$SCRIPT_DIR/pypi/pyproject.toml').read_text())
assert config['build-system']['requires'] == ['setuptools==82.0.1', 'wheel==0.47.0']
assert config['project']['license'] == 'MIT'
assert config['project']['license-files'] == ['LICENSE']
"

  check "PyPI build lock pins and hashes every requirement" python3 -c "
import pathlib, re
lock = pathlib.Path('$SCRIPT_DIR/pypi/build-requirements.lock').read_text()
logical = lock.replace('\\\\\n', '')
required = ('build==1.4.4', 'pyyaml==6.0.3', 'setuptools==82.0.1', 'twine==6.2.0', 'wheel==0.47.0')
for pin in required:
    match = re.search(rf'(?m)^{re.escape(pin)}(?: |$).*--hash=sha256:', logical)
    assert match, f'missing hashed direct pin: {pin}'
for line in logical.splitlines():
    if re.match(r'^[A-Za-z0-9]', line):
        assert '==' in line and '--hash=sha256:' in line, f'unlocked requirement: {line}'
"

  # Build test
  if python3 -c "
from importlib import metadata
expected = {'build': '1.4.4', 'PyYAML': '6.0.3', 'setuptools': '82.0.1', 'twine': '6.2.0', 'wheel': '0.47.0'}
assert all(metadata.version(name) == version for name, version in expected.items())
" 2>/dev/null; then
    PYPI_ARTIFACT_DIR="$(mktemp -d /tmp/elizaos-pypi-artifacts.XXXXXX)"
    check "Package builds with reviewed tools" \
      bash -c "cd '$SCRIPT_DIR/pypi' && python3 -m build --no-isolation --outdir '$PYPI_ARTIFACT_DIR'"
    check "Wheel and sdist carry exact MIT license" \
      python3 "$SCRIPT_DIR/pypi/verify_artifacts.py" "$PYPI_ARTIFACT_DIR"
    check "Twine accepts built artifacts" \
      bash -c "python3 -m twine check '$PYPI_ARTIFACT_DIR'/*"
    rm -rf "$PYPI_ARTIFACT_DIR"
  else
    skip "Package build" "reviewed build tool versions are not installed"
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
from elizaos_app.loader import _parse_version, _pep440_to_npm_version
assert _parse_version('v22.12.0') == (22, 12, 0)
assert _parse_version('v18.0.0') == (18, 0, 0)
assert _parse_version('v1.2.3-nightly') == (1, 2, 3)
assert _parse_version('not-a-version') is None
assert _pep440_to_npm_version('2.1.3') == '2.1.3'
assert _pep440_to_npm_version('2.1.3b4') == '2.1.3-beta.4'
assert _pep440_to_npm_version('2.1.3rc5') == '2.1.3-rc.5'
for unsupported in ('2.1.3a1', '2.1.3.dev1', '2.1', 'latest', ''):
    try:
        _pep440_to_npm_version(unsupported)
    except ValueError:
        pass
    else:
        raise AssertionError(f'accepted unsupported version: {unsupported}')
"

  check "Node detection" python3 -c "
import sys; sys.path.insert(0, '$SCRIPT_DIR/pypi')
from elizaos_app.loader import _find_node, _get_node_version
node = _find_node()
assert node, 'Node not found'
ver = _get_node_version(node)
assert ver and ver >= (24, 0, 0), f'Bad node version: {ver}'
"
  check "PyPI loader requires Node 24" grep -q 'MIN_NODE_VERSION = (24, 0, 0)' "$SCRIPT_DIR/pypi/elizaos_app/loader.py"
else
  skip "Python tests" "python3 not available"
fi

echo ""

# ── 2. Homebrew Formula & Cask ─────────────────────────────────────────────────
bold "2. Homebrew external tap"
check_file "Homebrew ownership documentation" "$SCRIPT_DIR/homebrew/README.md"
check_file "Homebrew tap dispatch workflow" "$REPO_ROOT/.github/workflows/update-homebrew.yml"
check "No stale in-repository Homebrew definitions" \
  bash -c "test ! -e '$SCRIPT_DIR/homebrew/elizaos-app.rb' && test ! -e '$SCRIPT_DIR/homebrew/elizaos-app.cask.rb'"
check "Homebrew update targets the authoritative external tap" \
  bash -c "workflow='$REPO_ROOT/.github/workflows/update-homebrew.yml'; grep -Fq 'repository: elizaOS/homebrew-tap' \"\$workflow\" && grep -Fq 'event-type: update-homebrew' \"\$workflow\""
check "Homebrew update fails closed on credentials and non-stable versions" \
  bash -c "workflow='$REPO_ROOT/.github/workflows/update-homebrew.yml'; grep -Fq 'HOMEBREW_TAP_TOKEN is required' \"\$workflow\" && grep -Fq 'Homebrew updates require an exact stable semver version' \"\$workflow\" && ! grep -Fq 'Homebrew tap update skipped' \"\$workflow\""
check "Homebrew updates are globally serialized" \
  bash -c "workflow='$REPO_ROOT/.github/workflows/update-homebrew.yml'; grep -Fq 'group: update-homebrew' \"\$workflow\" && grep -Fq 'cancel-in-progress: false' \"\$workflow\""

echo ""

# ── 3. Debian Packaging ─────────────────────────────────────────────────────
bold "3. Debian/apt Packaging"
check_file "runtime license inventory generator" "$SCRIPT_DIR/generate-license-inventory.mjs"
check_file "runtime license inventory fixture" "$SCRIPT_DIR/generate-license-inventory.test.mjs"
check_file "buffers 0.1.1 reviewed MIT evidence" "$SCRIPT_DIR/licenses/buffers-0.1.1-MIT.txt"
check_file "MetaMask eth-json-rpc-provider 1.0.1 reviewed ISC evidence" "$SCRIPT_DIR/licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt"
check_file "debian/control" "$SCRIPT_DIR/debian/control"
check_file "debian/rules" "$SCRIPT_DIR/debian/rules"
check_file "debian/changelog" "$SCRIPT_DIR/debian/changelog"
check_file "debian/copyright" "$SCRIPT_DIR/debian/copyright"
check_file "debian/postinst" "$SCRIPT_DIR/debian/postinst"
check_file "debian/prerm" "$SCRIPT_DIR/debian/prerm"
check_file "Debian user service" "$SCRIPT_DIR/debian/elizaos-app.user.service"
check_file "Debian maintainer-script verifier" "$SCRIPT_DIR/debian/verify-maintainer-scripts.sh"
check_file "debian/source/format" "$SCRIPT_DIR/debian/source/format"

check "rules is executable" test -x "$SCRIPT_DIR/debian/rules"
check "postinst is executable" test -x "$SCRIPT_DIR/debian/postinst"
check "Control has Package field" grep -q "^Package: elizaos-app" "$SCRIPT_DIR/debian/control"
check "Debian advertises only its bootable amd64 architecture" grep -q '^Architecture: amd64' "$SCRIPT_DIR/debian/control"
check "APT repository advertises only published amd64 indexes" \
  bash -c "test \"\$(grep -c '^Architectures: amd64$' '$SCRIPT_DIR/debian/apt-repo-config/conf/distributions')\" -eq 2 && ! grep -q 'arm64' '$SCRIPT_DIR/debian/apt-repo-config/conf/distributions'"
check "Control has Depends" grep -q "Depends:" "$SCRIPT_DIR/debian/control"
check "Debian has no host Node.js dependency" \
  bash -c "! grep -Eq '^Depends:.*nodejs' '$SCRIPT_DIR/debian/control'"
check "Debian obtains FFmpeg from the platform package" \
  grep -Eq '^Depends: .*ffmpeg([,[:space:]]|$)' "$SCRIPT_DIR/debian/control"
check "Debian derives native-library dependencies" grep -Fq '${shlibs:Depends}' "$SCRIPT_DIR/debian/control"
check "Debian retains debhelper dependencies" grep -Fq '${misc:Depends}' "$SCRIPT_DIR/debian/control"
check "Changelog has version" grep -q "elizaos-app (" "$SCRIPT_DIR/debian/changelog"
check "Compat level 13" grep -q "debhelper-compat (= 13)" "$SCRIPT_DIR/debian/control"
check "Source format 3.0 quilt" grep -q "3.0 (quilt)" "$SCRIPT_DIR/debian/source/format"
check "Debian consumes prepared runtime" grep -q 'packaging/debian/runtime' "$SCRIPT_DIR/debian/rules"
check "Debian consumes content-pinned Node runtime" grep -q 'packaging/debian/node-runtime' "$SCRIPT_DIR/debian/rules"
check "Debian launches built agent package" grep -q 'node_modules/@elizaos/agent/bin.js' "$SCRIPT_DIR/debian/rules"
check "Debian launcher uses only bundled Node" \
  grep -Fq 'exec /usr/lib/elizaos-app/node/bin/node /usr/lib/elizaos-app/node_modules/@elizaos/agent/bin.js' "$SCRIPT_DIR/debian/rules"
check "Debian subprocesses resolve the bundled Node toolchain first" \
  grep -Fq 'export PATH=/usr/lib/elizaos-app/node/bin:$$PATH' "$SCRIPT_DIR/debian/rules"
check "Debian requires Node license and provenance inputs" \
  bash -c "grep -Fq 'test -s \$(NODE_RUNTIME_DIR)/LICENSE' '$SCRIPT_DIR/debian/rules' && grep -Fq 'test -s \$(NODE_RUNTIME_DIR)/elizaos-runtime-provenance.json' '$SCRIPT_DIR/debian/rules'"
check "Debian installs Node license and provenance documentation" \
  bash -c "grep -Fq 'nodejs-LICENSE' '$SCRIPT_DIR/debian/rules' && grep -Fq 'nodejs-runtime-provenance.json' '$SCRIPT_DIR/debian/rules'"
check "Runtime inventory is closure-derived, text-bearing, and fail-closed" \
  bash -c "grep -Fq 'elizaos-runtime-dependencies.json' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'runtimeDependencyInventorySha256' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'payloadSha256' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'licenseTexts' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'Third-party dependencies have no retained license terms' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'Dependency uses a prohibited license' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'licensePolicyCounts' '$SCRIPT_DIR/generate-license-inventory.mjs'"
check "Runtime inventory carries reviewed licenses omitted from published package tarballs" \
  bash -c "grep -Fq '@lit-labs/ssr-dom-shim@1.6.0' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'encode-utf8@1.0.3' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'tr46@6.0.0' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'uint8arrays@3.1.0' '$SCRIPT_DIR/generate-license-inventory.mjs'"
check "Runtime inventory carries complete rpc-websockets LGPL compliance material" \
  bash -c "grep -Fq 'rpc-websockets@9.3.9' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'GNU-LGPL-3.0.txt' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'packages/os/linux/tails/COPYING' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'SOURCE AND RELINKING INFORMATION' '$SCRIPT_DIR/licenses/rpc-websockets-9.3.9-NOTICE.txt'"
check "Runtime inventory ships the reviewed buffers copyright and MIT text" \
  bash -c "grep -Fq 'buffers@0.1.1' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'licenses/buffers-0.1.1-MIT.txt' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'Copyright (c) 2015 James Halliday' '$SCRIPT_DIR/licenses/buffers-0.1.1-MIT.txt'"
check "Runtime inventory ships the reviewed MetaMask ISC clarification" \
  bash -c "grep -Fq '@metamask/eth-json-rpc-provider@1.0.1' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq '69d7d5d073de339766117658ea23293870a45e11' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq '0b03e62ba9941c1bdffe61b5e45b9e9d9e4c7c9ad18609ab879fd481eb2916f4' '$SCRIPT_DIR/generate-license-inventory.mjs' && grep -Fq 'Copyright (c) 2022 MetaMask' '$SCRIPT_DIR/licenses/metamask-eth-json-rpc-provider-1.0.1-ISC.txt'"
check "Runtime does not redistribute OpenCode binaries" \
  node --input-type=module - \
    "$REPO_ROOT/plugins/plugin-agent-orchestrator/package.json" \
    "$SCRIPT_DIR/generate-license-inventory.mjs" <<'NODE'
import { readFileSync } from "node:fs";

// The orchestrator resolves its OpenCode toolchain at runtime; the packaged
// npm payload must not carry opencode binaries or platform packages, and the
// license inventory must not advertise reviewed OpenCode redistribution.
const [manifestPath, inventoryPath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const inventorySource = readFileSync(inventoryPath, "utf8");
const allDependencies = {
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
};
const opencodeDependencies = Object.keys(allDependencies).filter((name) =>
  name.startsWith("opencode-"),
);
if (opencodeDependencies.length > 0) {
  throw new Error(`Unreviewed OpenCode platform packages: ${opencodeDependencies.join(", ")}`);
}
if (manifest.bin !== undefined) {
  throw new Error("Orchestrator package must not expose a packaged bin shim");
}
if (manifest.files?.some((entry) => entry === "bin" || entry.startsWith("bin/"))) {
  throw new Error("Orchestrator package files must not include bin/ shims");
}
if (/opencode/iu.test(inventorySource)) {
  throw new Error("License inventory still advertises OpenCode redistribution");
}
NODE
check "Runtime inventory fixture proves exact closure and local license evidence" \
  node --test "$SCRIPT_DIR/generate-license-inventory.test.mjs"
check "Debian installs exact project and runtime-closure legal evidence" \
  bash -c "grep -Fq 'test -s \$(RUNTIME_DIR)/LICENSE' '$SCRIPT_DIR/debian/rules' && grep -Fq 'test -s \$(RUNTIME_DIR)/THIRD_PARTY_NOTICES.json' '$SCRIPT_DIR/debian/rules' && grep -Fq 'elizaos-LICENSE' '$SCRIPT_DIR/debian/rules' && grep -Fq 'third-party-notices.json' '$SCRIPT_DIR/debian/rules'"
check "Debian copyright does not blanket-license the dependency closure" \
  bash -c "! grep -Eq '^Files:[[:space:]]+\*$' '$SCRIPT_DIR/debian/copyright' && grep -Fq 'blanket MIT assertion' '$SCRIPT_DIR/debian/copyright' && grep -Fq '/usr/share/doc/elizaos-app/third-party-notices.json' '$SCRIPT_DIR/debian/copyright'"
check "Debian preserves audited native bytes from dh_dwz" \
  awk '/^override_dh_dwz:/{getline; while ($0 ~ /^\t#/){getline}; found=($0 == "\ttrue")} END{exit !found}' "$SCRIPT_DIR/debian/rules"
check "Debian preserves audited native bytes from dh_strip" \
  awk '/^override_dh_strip:/{getline; while ($0 ~ /^\t#/){getline}; found=($0 == "\ttrue")} END{exit !found}' "$SCRIPT_DIR/debian/rules"
check "Debian copyright records locked Node binary" \
  bash -c "grep -Fq 'https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz' '$SCRIPT_DIR/debian/copyright' && grep -Fq '472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6' '$SCRIPT_DIR/debian/copyright'"
check "Debian copyright records locked Node source" \
  bash -c "grep -Fq 'https://nodejs.org/dist/v24.15.0/node-v24.15.0.tar.xz' '$SCRIPT_DIR/debian/copyright' && grep -Fq 'a4f653d79ed140aaad921e8c22a3b585ca85cfdab80d4030f6309e4663a8a1c8' '$SCRIPT_DIR/debian/copyright'"
for media_export in \
  'FFMPEG_BIN=/usr/bin/ffmpeg' \
  'FFMPEG_PATH=/usr/bin/ffmpeg' \
  'ELIZA_FFMPEG_PATH=/usr/bin/ffmpeg' \
  'FFPROBE_PATH=/usr/bin/ffprobe' \
  'FFMPEG_LOCATION=/usr/bin'; do
  check "Debian launcher exports $media_export" \
    grep -Fq "export $media_export" "$SCRIPT_DIR/debian/rules"
done
check "Debian does not copy removed root launcher" bash -c "! grep -q 'elizaos-app.mjs' '$SCRIPT_DIR/debian/rules'"
check "Debian has no duplicate dh_install manifest" test ! -e "$SCRIPT_DIR/debian/install"
check "Debian service is packaged only through dh_installsystemduser" \
  bash -c "test ! -e '$SCRIPT_DIR/debian/elizaos-app.service' && grep -Fq 'ExecStart=/usr/bin/elizaos-app serve' '$SCRIPT_DIR/debian/elizaos-app.user.service' && ! grep -Eq 'install .*elizaos-app\\.service' '$SCRIPT_DIR/debian/rules'"
check "Debian maintainer sources never invoke systemctl" \
  bash -c "! grep -E '^[[:space:]]*(if[[:space:]]+![[:space:]]+)?systemctl[[:space:]]' '$SCRIPT_DIR/debian/postinst' '$SCRIPT_DIR/debian/prerm'"
check "Debian verifier proves debhelper's package-state upgrade paths" \
  bash -c "grep -Fq \"deb-systemd-helper --user unmask 'elizaos-app.service'\" '$SCRIPT_DIR/debian/verify-maintainer-scripts.sh' && grep -Fq \"deb-systemd-helper --quiet --user was-enabled 'elizaos-app.service'\" '$SCRIPT_DIR/debian/verify-maintainer-scripts.sh' && grep -Fq \"deb-systemd-helper --user enable 'elizaos-app.service'\" '$SCRIPT_DIR/debian/verify-maintainer-scripts.sh' && grep -Fq \"deb-systemd-helper --user update-state 'elizaos-app.service'\" '$SCRIPT_DIR/debian/verify-maintainer-scripts.sh' && grep -Fq \"deb-systemd-helper --user purge 'elizaos-app.service'\" '$SCRIPT_DIR/debian/verify-maintainer-scripts.sh' && grep -Fq 'maintainer scripts must not call systemctl directly' '$SCRIPT_DIR/debian/verify-maintainer-scripts.sh'"
for workflow in \
  "$REPO_ROOT/.github/workflows/build-debian-package.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml" \
  "$REPO_ROOT/.github/workflows/publish-packages.yml"; do
  check "$(basename "$workflow") verifies Debian H.264 encode and probe" \
    bash -c "grep -Fq '/usr/bin/ffmpeg -hide_banner' '$workflow' && grep -Fq '/usr/bin/ffprobe -v error' '$workflow' && grep -Fq -- '-c:v libx264 -pix_fmt yuv420p' '$workflow' && grep -Fq 'test \"\$CODEC_NAME\" = h264' '$workflow'"
  check "$(basename "$workflow") provisions locked Node after npm assembly" \
    workflow_prepares_locked_debian_node "$workflow"
  check "$(basename "$workflow") has no NodeSource runtime dependency" \
    workflow_avoids_host_node_dependency "$workflow"
  check "$(basename "$workflow") proves installed Node content and provenance" \
    workflow_proves_bundled_debian_node "$workflow"
  check "$(basename "$workflow") copies only tracked Debian metadata" \
    workflow_copies_only_debian_metadata "$workflow"
  check "$(basename "$workflow") installs locked-runtime download prerequisites" \
    bash -c "grep -Fq 'ca-certificates' '$workflow' && grep -Fq 'curl' '$workflow' && grep -Fq 'xz-utils' '$workflow'"
  check "$(basename "$workflow") retains the exact Node build environment" \
    bash -c "grep -Fq 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e' '$workflow' && grep -Fq 'node-version: \"24.15.0\"' '$workflow'"
  check "$(basename "$workflow") runs lintian as a fail-closed policy gate" \
    bash -c "grep -Fq 'lintian --fail-on error' '$workflow' && grep -Fq \"grep -Eq '^E:' lintian.log\" '$workflow' && grep -Fq 'path: lintian.log' '$workflow'"
  check "$(basename "$workflow") verifies generated user-service lifecycle scripts" \
    grep -Fq 'packaging/debian/verify-maintainer-scripts.sh' "$workflow"
  check "$(basename "$workflow") derives legal evidence from its prepared runtime" \
    workflow_generates_runtime_license_inventory "$workflow"
done
check "Standalone Debian build is a manual/reusable validation lane" \
  bash -c "grep -q '^  workflow_call:' '$REPO_ROOT/.github/workflows/build-debian-package.yml' && grep -q '^  workflow_dispatch:' '$REPO_ROOT/.github/workflows/build-debian-package.yml' && ! grep -q '^  release:' '$REPO_ROOT/.github/workflows/build-debian-package.yml' && ! grep -Fq 'softprops/action-gh-release' '$REPO_ROOT/.github/workflows/build-debian-package.yml'"
check "Release Debian build allows the measured real package lane to finish" \
  grep -Fq 'timeout-minutes: 90' "$REPO_ROOT/.github/workflows/build-debian-package.yml"

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
check "Snap is publishable to stable channels" grep -q '^grade: stable' "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has base" grep -q "^base: core22" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has apps section" grep -q "^apps:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has node part" grep -q "^  node:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Has elizaos-app part" grep -q "^  elizaos-app:" "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Snap uses required Node runtime" grep -q 'NODE_VERSION="24.15.0"' "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Snap advertises only its bootable amd64 architecture" \
  bash -c "grep -q 'build-for: \[amd64\]' '$SCRIPT_DIR/snap/snapcraft.yaml' && ! grep -q 'arm64' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Snap verifies its Node archive" bash -c "grep -c 'sha256sum -c -' '$SCRIPT_DIR/snap/snapcraft.yaml' | grep -qx 1"
check "Snap has no floating toolchain downloads" bash -c "! grep -q '/releases/latest/' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Snap consumes the prebuilt production runtime" grep -q 'source: packages/app-core/packaging/snap' "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Snap launches built agent package" grep -q 'node_modules/@elizaos/agent/bin.js' "$SCRIPT_DIR/snap/snapcraft.yaml"
check "Snap installs exact project and runtime-closure legal evidence" \
  bash -c "grep -Fq 'test -s \"\$RUNTIME/LICENSE\"' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -Fq 'test -s \"\$RUNTIME/THIRD_PARTY_NOTICES.json\"' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -Fq 'usr/share/licenses/elizaos-app/LICENSE' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -Fq 'usr/share/licenses/elizaos-app/THIRD_PARTY_NOTICES.json' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Snap uses the canonical persistent state contract" \
  bash -c "grep -Fq 'ELIZA_STATE_DIR: \$SNAP_USER_COMMON/state/eliza' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -Fq 'XDG_STATE_HOME: \$SNAP_USER_COMMON/state' '$SCRIPT_DIR/snap/snapcraft.yaml' && ! grep -Fq 'ELIZAOS_APP_DATA_DIR' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Snap declares the external FFmpeg content provider" \
  bash -c "grep -q '^  ffmpeg-2204:' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -q 'target: ffmpeg-platform' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -q 'default-provider: ffmpeg-2204' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Snap app connects the FFmpeg content provider" \
  grep -Eq '^[[:space:]]+- ffmpeg-2204$' "$SCRIPT_DIR/snap/snapcraft.yaml"
for media_path in \
  'FFMPEG_BIN: $SNAP/ffmpeg-platform/usr/bin/ffmpeg' \
  'FFMPEG_PATH: $SNAP/ffmpeg-platform/usr/bin/ffmpeg' \
  'ELIZA_FFMPEG_PATH: $SNAP/ffmpeg-platform/usr/bin/ffmpeg' \
  'FFPROBE_PATH: $SNAP/ffmpeg-platform/usr/bin/ffprobe' \
  'FFMPEG_LOCATION: $SNAP/ffmpeg-platform/usr/bin'; do
  check "Snap exports $media_path" grep -Fq "$media_path" "$SCRIPT_DIR/snap/snapcraft.yaml"
done
check "Snap does not load host tsconfig through tsx" bash -c "! grep -q -- '--import .*tsx' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Snap build scripts do not swallow parse or setup failures" bash -c "! grep -Fq 'catch {}' '$SCRIPT_DIR/snap/snapcraft.yaml' && ! grep -Eq '(patch-deps|link-browser-server)\\.mjs.*\\|\\| true' '$SCRIPT_DIR/snap/snapcraft.yaml'"
for workflow in \
  "$REPO_ROOT/.github/workflows/snap-build-test.yml" \
  "$REPO_ROOT/.github/workflows/snap-publish.yml"; do
  check "$(basename "$workflow") audits native libraries with the runtime search path" \
    grep -Fq 'export LD_LIBRARY_PATH="$SNAP/ffmpeg-platform/usr/lib/x86_64-linux-gnu:$SNAP/usr/lib/x86_64-linux-gnu:$SNAP/lib/x86_64-linux-gnu"' "$workflow"
  check "$(basename "$workflow") installs and connects the FFmpeg provider" \
    bash -c "grep -Fq 'sudo snap install ffmpeg-2204' '$workflow' && grep -Fq 'sudo snap connect elizaos-app:ffmpeg-2204 ffmpeg-2204:ffmpeg-2204' '$workflow'"
  check "$(basename "$workflow") resolves media tools from the content mount" \
    bash -c "grep -Fq 'test \"\$(command -v ffmpeg)\" = \"\$SNAP/ffmpeg-platform/usr/bin/ffmpeg\"' '$workflow' && grep -Fq 'test \"\$(command -v ffprobe)\" = \"\$SNAP/ffmpeg-platform/usr/bin/ffprobe\"' '$workflow'"
  check "$(basename "$workflow") verifies provider H.264 encode and probe" \
    bash -c "grep -Fq -- '-c:v libx264 -pix_fmt yuv420p' '$workflow' && grep -Fq -- '-show_entries stream=codec_name' '$workflow' && grep -Fq 'test \"\$CODEC_NAME\" = h264' '$workflow'"
  check "$(basename "$workflow") derives legal evidence from its prepared runtime" \
    workflow_generates_runtime_license_inventory "$workflow"
  check "$(basename "$workflow") proves installed legal evidence and persistent state" \
    bash -c "grep -Fq '\$SNAP/usr/share/licenses/elizaos-app/LICENSE' '$workflow' && grep -Fq '\$SNAP/usr/share/licenses/elizaos-app/THIRD_PARTY_NOTICES.json' '$workflow' && grep -Fq 'inventory.packageCount !== inventory.packages.length' '$workflow' && grep -Fq 'snap-persistence-smoke' '$workflow'"
done
check "Publish packages delegates Snap to the hardened reusable workflow" \
  bash -c "grep -Fq 'uses: ./.github/workflows/snap-publish.yml' '$REPO_ROOT/.github/workflows/publish-packages.yml' && grep -Fq 'channel: \${{ needs.prepare.outputs.is_prerelease == '\''true'\'' && '\''beta'\'' || '\''stable'\'' }}' '$REPO_ROOT/.github/workflows/publish-packages.yml' && ! grep -Fq 'snapcore/action-publish@' '$REPO_ROOT/.github/workflows/publish-packages.yml'"
check "Snap publishers share one repository-wide concurrency gate" \
  bash -c "grep -Fq 'group: snap-publish' '$REPO_ROOT/.github/workflows/snap-publish.yml' && grep -Fq 'cancel-in-progress: false' '$REPO_ROOT/.github/workflows/snap-publish.yml' && ! grep -Fq 'snap-publish-\${{ inputs.channel }}' '$REPO_ROOT/.github/workflows/snap-publish.yml'"

echo ""

# ── 5. Flatpak Package ──────────────────────────────────────────────────────
bold "5. Flatpak Package"
check_file "Flatpak manifest (direct)" "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml"
check_file "Flatpak manifest (store)" "$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml"
check_file "Flatpak README" "$SCRIPT_DIR/flatpak/README.md"
check_file "Desktop entry" "$SCRIPT_DIR/flatpak/ai.elizaos.App.desktop"
check_file "Metainfo XML" "$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml"
check_file "Direct wrapper" "$SCRIPT_DIR/flatpak/elizaos-app-wrapper.sh"
check_file "Store wrapper" "$SCRIPT_DIR/flatpak/elizaos-app-wrapper.store.sh"
check_file "Node runtime provenance" "$SCRIPT_DIR/flatpak/node-runtime-provenance.json"

if command -v node &>/dev/null; then
  check "Flatpak Node provenance matches the shared lock" node --input-type=module -e "
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOCKED_NODE_ARCHIVE,
  LOCKED_NODE_EXECUTABLE,
  LOCKED_NODE_PLATFORM,
  LOCKED_NODE_SOURCE,
  LOCKED_NODE_VERSION,
} from '$REPO_ROOT/packages/scripts/locked-node-runtime.mjs';
const actual = JSON.parse(readFileSync('$SCRIPT_DIR/flatpak/node-runtime-provenance.json', 'utf8'));
assert.deepEqual(actual, {
  sourceUrl: LOCKED_NODE_ARCHIVE.url,
  archiveSha256: LOCKED_NODE_ARCHIVE.sha256,
  executableSha256: LOCKED_NODE_EXECUTABLE.sha256,
  source: LOCKED_NODE_SOURCE,
  version: LOCKED_NODE_VERSION,
  platform: LOCKED_NODE_PLATFORM,
});
"
else
  skip "Flatpak Node provenance" "node not installed"
fi

# Validate YAML
if python_has_module yaml; then
  check "Direct manifest YAML valid" python3 -c "
import yaml, pathlib
yaml.safe_load(pathlib.Path('$SCRIPT_DIR/flatpak/ai.elizaos.App.yml').read_text())
"
  check "Store manifest YAML valid" python3 -c "
import yaml, pathlib
yaml.safe_load(pathlib.Path('$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml').read_text())
"
elif command -v python3 &>/dev/null; then
  skip "Manifest YAML valid" "pyyaml not installed"
fi

check "SHA256 not placeholder (x64)" bash -c "! grep -q PLACEHOLDER_SHA256_X64 '$SCRIPT_DIR/flatpak/ai.elizaos.App.yml'"
check "Has app-id" grep -q "^app-id: ai.elizaos.App" "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml"
check "Has runtime" grep -q "runtime: org.freedesktop" "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml"
check "Desktop entry has Exec" grep -q "^Exec=" "$SCRIPT_DIR/flatpak/ai.elizaos.App.desktop"
check "Desktop entry starts the serving agent" grep -q '^Exec=elizaos-app serve' "$SCRIPT_DIR/flatpak/ai.elizaos.App.desktop"
check "Metainfo has app-id" grep -q "ai.elizaos.App" "$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml"
check "Flatpak metadata points to the monorepo" \
  bash -c "grep -Fq '<url type=\"bugtracker\">https://github.com/elizaOS/eliza/issues</url>' '$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml' && grep -Fq '<url type=\"vcs-browser\">https://github.com/elizaOS/eliza</url>' '$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml' && ! grep -Fq 'elizaos-app/issues' '$SCRIPT_DIR/flatpak/ai.elizaos.App.metainfo.xml'"
for manifest in \
  "$SCRIPT_DIR/flatpak/ai.elizaos.App.yml" \
  "$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml"; do
  check "$(basename "$manifest") consumes prepared runtime" \
    grep -q 'path: runtime' "$manifest"
  check "$(basename "$manifest") uses required Node runtime" \
    grep -q 'node-v24.15.0-linux' "$manifest"
  check "$(basename "$manifest") is truthful x86_64-only" \
    bash -c "grep -q 'node-v24.15.0-linux-x64' '$manifest' && ! grep -q 'linux-arm64' '$manifest'"
  check "$(basename "$manifest") installs the full Node license" \
    grep -Fq -- '- install -Dm644 LICENSE /app/share/licenses/ai.elizaos.App/nodejs-LICENSE' "$manifest"
  check "$(basename "$manifest") installs reviewed Node provenance" \
    bash -c "grep -Fq -- '- install -Dm644 node-runtime-provenance.json /app/share/licenses/ai.elizaos.App/nodejs-runtime-provenance.json' '$manifest' && grep -Fq 'path: node-runtime-provenance.json' '$manifest'"
  check "$(basename "$manifest") installs exact project and closure legal evidence" \
    bash -c "grep -Fq -- '- install -Dm644 runtime/LICENSE /app/share/licenses/ai.elizaos.App/elizaos-LICENSE' '$manifest' && grep -Fq -- '- install -Dm644 runtime/THIRD_PARTY_NOTICES.json /app/share/licenses/ai.elizaos.App/third-party-notices.json' '$manifest'"
  check "$(basename "$manifest") has no registry-time npm install" \
    bash -c "! grep -q 'npm install' '$manifest'"
  check "$(basename "$manifest") declares Freedesktop FFmpeg 24.08 extension" \
    bash -c "grep -q '^add-extensions:' '$manifest' && grep -q '^  org.freedesktop.Platform.ffmpeg-full:' '$manifest' && grep -q \"version: '24.08'\" '$manifest' && grep -q 'directory: lib/ffmpeg' '$manifest' && grep -q 'add-ld-path: \.' '$manifest'"
  check "$(basename "$manifest") creates the FFmpeg extension mount" \
    grep -Fq -- '- mkdir -p /app/lib/ffmpeg' "$manifest"
done
check "Direct wrapper launches agent binary" grep -q '/@elizaos/agent/bin.js' "$SCRIPT_DIR/flatpak/elizaos-app-wrapper.sh"
check "Store wrapper launches agent binary" grep -q '/@elizaos/agent/bin.js' "$SCRIPT_DIR/flatpak/elizaos-app-wrapper.store.sh"
for wrapper in "$SCRIPT_DIR"/flatpak/elizaos-app-wrapper*.sh; do
  check "$(basename "$wrapper") launches copied runtime root" \
    grep -q '/app/lib/elizaos-app/node_modules/@elizaos/agent/bin.js' "$wrapper"
  check "$(basename "$wrapper") uses canonical XDG state" \
    bash -c "grep -Fq 'ELIZA_STATE_DIR=\"\${ELIZA_STATE_DIR:-\$XDG_STATE_HOME/eliza}\"' '$wrapper' && grep -Fq 'mkdir -p \"\$ELIZA_STATE_DIR\"' '$wrapper' && ! grep -Fq 'ELIZAOS_APP_DATA_DIR' '$wrapper'"
  for media_export in \
    'FFMPEG_BIN=/usr/bin/ffmpeg' \
    'FFMPEG_PATH=/usr/bin/ffmpeg' \
    'ELIZA_FFMPEG_PATH=/usr/bin/ffmpeg' \
    'FFPROBE_PATH=/usr/bin/ffprobe' \
    'FFMPEG_LOCATION=/usr/bin'; do
    check "$(basename "$wrapper") exports $media_export" \
      grep -Fq "export $media_export" "$wrapper"
  done
done
check "Flatpak wrappers have no removed app launcher" bash -c "! grep -q 'elizaos-app.mjs' '$SCRIPT_DIR'/flatpak/elizaos-app-wrapper*.sh"
for workflow in \
  "$REPO_ROOT/.github/workflows/test-flatpak.yml" \
  "$REPO_ROOT/.github/workflows/publish-packages.yml"; do
  check "$(basename "$workflow") installs the Freedesktop FFmpeg extension" \
    grep -Fq 'org.freedesktop.Platform.ffmpeg-full//24.08' "$workflow"
  check "$(basename "$workflow") verifies Flatpak H.264 encode and probe in-app" \
    bash -c "grep -Fq -- '--command=/bin/sh ai.elizaos.App -s' '$workflow' && grep -Fq '/usr/bin/ffmpeg -hide_banner' '$workflow' && grep -Fq '/usr/bin/ffprobe -v error' '$workflow' && grep -Fq -- '-c:v libx264 -pix_fmt yuv420p' '$workflow' && grep -Fq 'test \"\$CODEC_NAME\" = h264' '$workflow'"
  check "$(basename "$workflow") proves installed Node bytes, version, license, and provenance" \
    bash -c "grep -Fq 'test \"\$(/app/bin/node --version)\" = v24.15.0' '$workflow' && grep -Fq 'd1de76d8edf2fededf6f8b30d244e2c0529ac607923a018283b77e9c74bd932c' '$workflow' && grep -Fq '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18' '$workflow' && grep -Fq '7b8cd9c2ea24afdb7ad8b1a0ba29a205909181a82ca25c3f45bcea96b9a8cc5f' '$workflow'"
  check "$(basename "$workflow") derives legal evidence from its prepared runtime" \
    workflow_generates_runtime_license_inventory "$workflow"
  check "$(basename "$workflow") proves installed legal evidence and XDG-state persistence" \
    bash -c "grep -Fq '/app/share/licenses/ai.elizaos.App/elizaos-LICENSE' '$workflow' && grep -Fq '/app/share/licenses/ai.elizaos.App/third-party-notices.json' '$workflow' && grep -Fq 'inventory.packageCount !== inventory.packages.length' '$workflow' && grep -Fq 'flatpak-persistence-smoke' '$workflow'"
done

check "Flatpak tests matrix both direct and store manifests" \
  bash -c "grep -Fq 'manifest: ai.elizaos.App.yml' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'manifest: ai.elizaos.App.store.yml' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'FLATPAK_MANIFEST: \${{ matrix.manifest }}' '$REPO_ROOT/.github/workflows/test-flatpak.yml'"
check "Flatpak matrix uses unique build, repository, and bundle names" \
  bash -c "grep -Fq 'FLATPAK_BUILD_DIR: build-dir-\${{ matrix.profile }}' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'FLATPAK_REPO: repo-\${{ matrix.profile }}' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'FLATPAK_BUNDLE: elizaos-app-\${{ matrix.profile }}.flatpak' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'name: flatpak-test-bundle-\${{ matrix.profile }}' '$REPO_ROOT/.github/workflows/test-flatpak.yml'"
check "Flatpak matrix builds, bundles, installs, and boots each profile" \
  bash -c "grep -Fq 'flatpak-builder \\' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'flatpak build-bundle' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'sudo flatpak --system install -y --reinstall \"\$FLATPAK_BUNDLE\"' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'node ../../../scripts/verify-packaged-cli.mjs' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq -- '--service-arg serve' '$REPO_ROOT/.github/workflows/test-flatpak.yml'"
check "Flatpak tests bind each smoke to the just-built commit" \
  bash -c "grep -Fq 'EXPECTED_COMMIT=\"\$(ostree --repo=\"\$FLATPAK_REPO\" rev-parse' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'INSTALLED_COMMIT=\"\$(sudo flatpak --system info --show-commit ai.elizaos.App)\"' '$REPO_ROOT/.github/workflows/test-flatpak.yml' && grep -Fq 'Installed Flatpak commit \$INSTALLED_COMMIT does not match bundle commit \$EXPECTED_COMMIT' '$REPO_ROOT/.github/workflows/test-flatpak.yml'"
check "Published Flatpak smoke is reinstalled from the just-built commit" \
  bash -c "grep -Fq 'sudo flatpak --system install -y --reinstall elizaos-app.flatpak' '$REPO_ROOT/.github/workflows/publish-packages.yml' && grep -Fq 'EXPECTED_COMMIT=\"\$(ostree --repo=repo rev-parse' '$REPO_ROOT/.github/workflows/publish-packages.yml' && grep -Fq 'INSTALLED_COMMIT=\"\$(sudo flatpak --system info --show-commit ai.elizaos.App)\"' '$REPO_ROOT/.github/workflows/publish-packages.yml'"

for runtime_root in \
  "$SCRIPT_DIR/debian/runtime" \
  "$SCRIPT_DIR/snap/runtime" \
  "$SCRIPT_DIR/flatpak/runtime"; do
  runtime_name="$(basename "$(dirname "$runtime_root")")"
  if [[ -d "$runtime_root" ]]; then
    check "$runtime_name runtime has no bundled FFmpeg executable" \
      runtime_has_no_bundled_media_executables "$runtime_root"
  else
    skip "$runtime_name runtime has no bundled FFmpeg executable" \
      "generated runtime is absent; package workflows assemble and inspect it"
  fi
done

# Store manifest sandbox lockdown — these grants would defeat the hardened
# side-load posture, so the manifest must NOT contain them.
check "Store: no --filesystem=home" bash -c "! grep -E -q -- '^[[:space:]]*-[[:space:]]+--filesystem=home' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Store: no --filesystem=host" bash -c "! grep -E -q -- '^[[:space:]]*-[[:space:]]+--filesystem=host' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Store: no host-spawn portal" bash -c "! grep -E -q -- '^[[:space:]]*-[[:space:]]+--talk-name=org\.freedesktop\.Flatpak' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Store: no --device=all" bash -c "! grep -E -q -- '^[[:space:]]*-[[:space:]]+--device=all' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Store: no session/system bus socket" bash -c "! grep -E -q -- '^[[:space:]]*-[[:space:]]+--socket=(session|system)-bus' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Store: has --share=network" grep -E -q -- "--share=network" "$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml"
check "Store: has no display sockets" bash -c "! grep -E -q -- '^[[:space:]]*-[[:space:]]+--socket=(wayland|fallback-x11|x11)' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Store: relies on sandbox XDG state without stale host grants" \
  bash -c "! grep -Fq -- '--persist=.eliza' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml' && ! grep -Fq -- '--filesystem=xdg-config/elizaos-app:create' '$SCRIPT_DIR/flatpak/ai.elizaos.App.store.yml'"
check "Direct: full-home grant is not paired with redundant XDG config grant" \
  bash -c "grep -Fq -- '--filesystem=home' '$SCRIPT_DIR/flatpak/ai.elizaos.App.yml' && ! grep -Fq -- '--filesystem=xdg-config/elizaos-app:create' '$SCRIPT_DIR/flatpak/ai.elizaos.App.yml'"
check "Store wrapper sets ELIZA_BUILD_VARIANT=store" grep -q 'ELIZA_BUILD_VARIANT=store' "$SCRIPT_DIR/flatpak/elizaos-app-wrapper.store.sh"

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

check "Has reusable workflow trigger" grep -q '^  workflow_call:' "$WORKFLOW"
check "Has workflow_dispatch" grep -q "workflow_dispatch:" "$WORKFLOW"
check "Has PyPI job" grep -q "publish-pypi:" "$WORKFLOW"
# Homebrew is handled by the standalone update-homebrew.yml workflow
check "Has Homebrew job" test -f "$REPO_ROOT/.github/workflows/update-homebrew.yml"
check "Has Snap job" grep -q "publish-snap:" "$WORKFLOW"
check "Has Debian job" grep -q "build-deb:" "$WORKFLOW"
check "Has Flatpak job" grep -q "build-flatpak:" "$WORKFLOW"
check "Has summary job" grep -q "publish-summary:" "$WORKFLOW"
check "Reusable PyPI publisher declares the established token secret" \
  grep -Fq 'PYPI_TOKEN:' "$WORKFLOW"
check "Reusable PyPI publisher fails before build without its token" \
  grep -Fq 'PyPI publishing is enabled but PYPI_TOKEN is unavailable' "$WORKFLOW"
check "Reusable PyPI publisher does not request unsupported OIDC" \
  bash -c "! grep -Fq 'id-token: write' '$WORKFLOW'"
check "Pinned PyPI action uses only PYPI_TOKEN and disables attestations" \
  bash -c "grep -Fq 'password: \${{ secrets.PYPI_TOKEN }}' '$WORKFLOW' && grep -Fq 'attestations: false' '$WORKFLOW' && ! grep -Fq 'PYPI_API_TOKEN' '$WORKFLOW'"
check "Snap publishing uses the canonical credential contract" \
  bash -c "grep -Fq 'SNAPCRAFT_STORE_CREDENTIALS:' '$WORKFLOW' && ! grep -Fq 'SNAP_STORE_CREDENTIALS' '$WORKFLOW'"
check "One post-publication workflow owns Debian, APT, and Snap" \
  release_distribution_has_single_package_owner
check "Existing Debian release assets are immutable across retries" \
  release_debian_attachment_is_byte_idempotent "$WORKFLOW"
check "Existing Flatpak release assets are immutable across retries" \
  release_flatpak_attachment_is_byte_idempotent "$WORKFLOW"
check "Snap install docs match strict confinement" bash -c "! grep -Eq 'snap install elizaos-app .*--classic' '$WORKFLOW' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Release version enters publishing shell through env" \
  grep -Fq 'RELEASE_VERSION: ${{ inputs.version }}' "$WORKFLOW"
check "Release version validation is anchored and fail-closed" \
  grep -Fq 'Release version must be stable, beta.N, or rc.N semver' "$WORKFLOW"
check "Package publication is serialized across release refs" \
  bash -c "grep -Fq 'group: publish-packages' '$WORKFLOW' && grep -Fq 'cancel-in-progress: false' '$WORKFLOW' && ! grep -Fq 'publish-packages-\${{ github.ref }}' '$WORKFLOW'"
check "Every inline publisher binds and proves the validated release tag" \
  bash -c 'checkout_count="$(grep -c "uses: actions/checkout@" "$1")"; test "$checkout_count" -gt 0; test "$(grep -Fc '\''ref: v${{ needs.prepare.outputs.version }}'\'' "$1")" -eq "$checkout_count"; test "$(grep -Fc '\''fetch-depth: 0'\'' "$1")" -eq "$checkout_count"; test "$(grep -Fc '\''name: Verify release tag identity'\'' "$1")" -eq "$checkout_count"; test "$(grep -Fc '\''TAG_COMMIT="$(git rev-parse "$EXPECTED_TAG^{commit}")"'\'' "$1")" -eq "$checkout_count"' _ "$WORKFLOW"
check "Required PyPI jobs cannot degrade to a directory-missing skip" \
  bash -c "! grep -q 'pypi_check' '$REPO_ROOT/.github/workflows/test-packaging.yml'"

APT_WORKFLOW="$REPO_ROOT/.github/workflows/publish-apt-repo.yml"
check "APT branch publication is serialized" \
  bash -c "grep -Fq 'group: publish-apt-repo' '$APT_WORKFLOW' && grep -Fq 'cancel-in-progress: false' '$APT_WORKFLOW'"
check "APT workflow has only repository-content permission" \
  bash -c "grep -Fq 'contents: write' '$APT_WORKFLOW' && ! grep -Eq '^[[:space:]]+(pages|id-token):' '$APT_WORKFLOW'"
check "APT signer requires an exact 40-hex fingerprint" \
  bash -c "grep -Fq '^[0-9A-Fa-f]{40}$' '$APT_WORKFLOW' && grep -Fq 'exact 40-hex primary-key fingerprint' '$APT_WORKFLOW'"
check "APT signer uses a unique isolated GPG home" \
  bash -c "grep -Fq 'PUBLISH_ROOT=\"\$RUNNER_TEMP/elizaos-apt-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-\${GITHUB_JOB}\"' '$APT_WORKFLOW' && grep -Fq 'GNUPGHOME=\$PUBLISH_ROOT/gnupg' '$APT_WORKFLOW'"
check "APT signer accepts exactly one matching secret primary key" \
  bash -c "grep -Fq 'SECRET_PRIMARY_FINGERPRINTS' '$APT_WORKFLOW' && grep -Fq 'PUBLIC_PRIMARY_FINGERPRINTS' '$APT_WORKFLOW' && grep -Fq 'Imported primary-key fingerprint does not exactly match DEBIAN_GPG_KEY_ID' '$APT_WORKFLOW'"
check "APT branch begins at a commit rather than a tree object" \
  bash -c "grep -Fq 'commit-tree \"\$EMPTY_TREE\"' '$APT_WORKFLOW' && grep -Fq '\$EMPTY_COMMIT^{commit}' '$APT_WORKFLOW' && ! grep -Eq 'hash-object -t tree.*refs/heads/apt-repo' '$APT_WORKFLOW'"
check "APT downloads releases into a unique runner directory" \
  bash -c "grep -Fq 'DEB_DOWNLOAD_DIR=\$PUBLISH_ROOT/downloads' '$APT_WORKFLOW' && ! grep -Fq '/tmp/deb' '$APT_WORKFLOW'"
check "APT configuration replaces and rejects every default signer" \
  bash -c "grep -Fq 'SIGNWITH_DEFAULT_COUNT' '$APT_WORKFLOW' && grep -Fq 'SignWith: \$DEBIAN_GPG_FINGERPRINT' '$APT_WORKFLOW' && grep -Fq 'APT configuration retained an ambiguous SignWith: default' '$APT_WORKFLOW'"
check "APT public key export selects only the verified fingerprint" \
  grep -Fq 'gpg --batch --armor --export "$DEBIAN_GPG_FINGERPRINT!"' "$APT_WORKFLOW"
check "APT publisher primes the isolated signer and always re-exports metadata" \
  apt_publish_primes_signer_and_reexports "$APT_WORKFLOW"
check "APT publisher retries only byte-identical package records" \
  apt_publish_is_byte_idempotent "$APT_WORKFLOW"
check "APT publication is nested behind the verified Debian producer" \
  bash -c "grep -Fq 'needs: [prepare, build-deb]' '$WORKFLOW' && grep -Fq 'uses: ./.github/workflows/publish-apt-repo.yml' '$WORKFLOW' && ! grep -Fq 'repos/elizaOS/apt' '$WORKFLOW' && ! grep -Fq 'APT_REPO_TOKEN' '$WORKFLOW'"
FLATHUB_WORKFLOW="$REPO_ROOT/.github/workflows/flatpak-publish.yml"
check_file "flatpak-publish.yml" "$FLATHUB_WORKFLOW"
check "Flatpak publication delegates to the verified side-load bundle path" \
  bash -c "grep -Fq 'uses: ./.github/workflows/publish-packages.yml' '$FLATHUB_WORKFLOW' && grep -Fq 'flatpak: true' '$FLATHUB_WORKFLOW' && ! grep -Eq 'FLATHUB_TOKEN|gh repo fork|gh pr create|sed -i' '$FLATHUB_WORKFLOW' && ! grep -Fq '|| true' '$FLATHUB_WORKFLOW'"

for audited_workflow in \
  build-debian-package.yml \
  build-linux-iso.yml \
  build-vm-image.yml \
  elizaos-os-full-release.yml \
  flatpak-publish.yml \
  publish-apt-repo.yml \
  publish-packages.yml \
  release-all.yml \
  release-orchestrator.yml \
  release.yaml \
  snap-build-test.yml \
  snap-publish.yml \
  test-flatpak.yml \
  test-packaging.yml; do
  check "$audited_workflow changes trigger packaging validation" \
    workflow_triggers_packaging_validator "$audited_workflow"
done
for workflow in \
  "$REPO_ROOT/.github/workflows/publish-packages.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml"; do
  check "$(basename "$workflow") uses the hash-locked PyPI build closure" \
    pypi_workflow_uses_locked_build_tools "$workflow"
  check "$(basename "$workflow") rejects every unreviewed pip install" \
    workflow_installs_python_packages_from_reviewed_sources "$workflow"
  check "$(basename "$workflow") validates PyPI artifacts with locked Twine" \
    grep -Fq 'python -m twine check ' "$workflow"
  check "$(basename "$workflow") exercises the deterministic Node timeout boundary" \
    grep -Fq 'python -m unittest -v test_loader.py' "$workflow"
done

for workflow in \
  "$REPO_ROOT/.github/workflows/build-debian-package.yml" \
  "$REPO_ROOT/.github/workflows/snap-build-test.yml" \
  "$REPO_ROOT/.github/workflows/snap-publish.yml" \
  "$REPO_ROOT/.github/workflows/test-flatpak.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml"; do
  check "$(basename "$workflow") reclaims hosted-runner disk and enforces capacity" \
    bash -c "grep -Fq 'sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL' '$workflow' && grep -Fq 'MIN_FREE_KB=\$((30 * 1024 * 1024))' '$workflow'"
done
check "Inline publish package jobs guard both large distribution builds" \
  bash -c "test \"\$(grep -c 'MIN_FREE_KB=' '$REPO_ROOT/.github/workflows/publish-packages.yml')\" -eq 2"
APT_PUBLISH_WORKFLOW="$REPO_ROOT/.github/workflows/publish-apt-repo.yml"
check_file "publish-apt-repo.yml" "$APT_PUBLISH_WORKFLOW"
check "APT publisher validates artifact identity before reprepro" \
  apt_publish_validates_artifact_before_reprepro "$APT_PUBLISH_WORKFLOW"
check "APT publisher removes isolated signing state on every outcome" \
  apt_publish_has_guarded_teardown "$APT_PUBLISH_WORKFLOW"
check "APT release-to-Debian version mapping covers stable, beta, and rc" bash -c '
for fixture in "2.3.4:2.3.4-1" "2.3.4-beta.7:2.3.4~beta7-1" "2.3.4-rc.2:2.3.4~rc2-1"; do
  release="${fixture%%:*}"
  expected="${fixture#*:}"
  actual="${release/-beta./~beta}"
  actual="${actual/-rc./~rc}-1"
  test "$actual" = "$expected"
done
'

for workflow in \
  "$REPO_ROOT/.github/workflows/publish-packages.yml" \
  "$REPO_ROOT/.github/workflows/snap-build-test.yml" \
  "$REPO_ROOT/.github/workflows/snap-publish.yml" \
  "$REPO_ROOT/.github/workflows/test-flatpak.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml" \
  "$REPO_ROOT/.github/workflows/build-debian-package.yml"; do
  check "$(basename "$workflow") has no drifting package toolchain" \
    bash -c "! grep -Eq 'node-version: [\"'\\'']?24[\"'\\'']?$|bun-version: [\"'\\'']?1\\.3\\.14[\"'\\'']?$' '$workflow'"
done

check "Publish workflow rejects bundled FFmpeg executables in both inline runtimes" \
  bash -c "test \"\$(grep -c 'name: Reject bundled FFmpeg executables' '$REPO_ROOT/.github/workflows/publish-packages.yml')\" -eq 2"
check "Publish workflow rejects absent generated runtimes before FFmpeg scans" \
  bash -c "test \"\$(grep -c 'test -d \"\$PACKAGED_RUNTIME\"' '$REPO_ROOT/.github/workflows/publish-packages.yml')\" -eq 2"
check "Publish workflow runs both inline H.264 provider smokes" \
  bash -c "test \"\$(grep -c -- '-c:v libx264 -pix_fmt yuv420p' '$REPO_ROOT/.github/workflows/publish-packages.yml')\" -eq 2"
for workflow in \
  "$REPO_ROOT/.github/workflows/snap-build-test.yml" \
  "$REPO_ROOT/.github/workflows/snap-publish.yml" \
  "$REPO_ROOT/.github/workflows/test-flatpak.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml" \
  "$REPO_ROOT/.github/workflows/build-debian-package.yml"; do
  check "$(basename "$workflow") rejects bundled FFmpeg executables" \
    bash -c "test \"\$(grep -c 'name: Reject bundled FFmpeg executables' '$workflow')\" -eq 1"
  check "$(basename "$workflow") rejects an absent runtime before its FFmpeg scan" \
    grep -Fq 'test -d "$PACKAGED_RUNTIME"' "$workflow"
  check "$(basename "$workflow") runs one H.264 provider smoke" \
    bash -c "test \"\$(grep -c -- '-c:v libx264 -pix_fmt yuv420p' '$workflow')\" -eq 1"
done

for workflow in \
  "$REPO_ROOT/.github/workflows/build-debian-package.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml" \
  "$REPO_ROOT/.github/workflows/publish-packages.yml"; do
  check "$(basename "$workflow") scans the final Debian payload" \
    bash -c "grep -Fq 'name: Reject FFmpeg executables in final Debian payload' '$workflow' && grep -Fq 'dpkg-deb --extract' '$workflow' && grep -Fq 'Final Debian payload must not redistribute FFmpeg executables' '$workflow'"
done

for workflow in \
  "$REPO_ROOT/.github/workflows/snap-build-test.yml" \
  "$REPO_ROOT/.github/workflows/snap-publish.yml"; do
  check "$(basename "$workflow") scans the final Snap payload" \
    bash -c "grep -Fq 'name: Reject FFmpeg executables in final Snap payload' '$workflow' && grep -Fq 'unsquashfs -no-progress' '$workflow' && grep -Fq 'Final Snap payload must not redistribute FFmpeg executables' '$workflow'"
  check "$(basename "$workflow") proves the explicit cross-publisher Snap connection" \
    bash -c "grep -Fq 'explicitly connect' '$workflow' && grep -Fq 'snap connections elizaos-app' '$workflow' && grep -Fq 'elizaos-app:ffmpeg-2204[[:space:]]+ffmpeg-2204:ffmpeg-2204' '$workflow'"
done

for workflow in \
  "$REPO_ROOT/.github/workflows/test-flatpak.yml" \
  "$REPO_ROOT/.github/workflows/publish-packages.yml"; do
  check "$(basename "$workflow") scans the final Flatpak app commit" \
    bash -c "grep -Fq 'ostree --repo=' '$workflow' && grep -Fq 'checkout \"\$EXPECTED_COMMIT\" \"\$APP_CHECKOUT\"' '$workflow' && grep -Fq 'find \"\$APP_CHECKOUT/files\"' '$workflow' && grep -Fq 'Final Flatpak app payload must not redistribute FFmpeg executables' '$workflow'"
done

for workflow in \
  "$REPO_ROOT/.github/workflows/snap-build-test.yml" \
  "$REPO_ROOT/.github/workflows/test-flatpak.yml" \
  "$REPO_ROOT/.github/workflows/test-packaging.yml"; do
  check "$(basename "$workflow") watches all runtime package inputs" \
    bash -c "grep -Fq \"'packages/**'\" '$workflow' && grep -Fq \"'plugins/**'\" '$workflow' && grep -Fq \"'package.json'\" '$workflow' && grep -Fq \"'bun.lock'\" '$workflow' && grep -Fq \"'patches/**'\" '$workflow'"
done

echo ""

# ── 7. Publishing Guide ─────────────────────────────────────────────────────
bold "7. Publishing Guide"
check_file "PUBLISHING_GUIDE.md" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers PyPI" grep -q "PyPI" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers Homebrew" grep -q "Homebrew" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers apt" grep -q "apt" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers Snap" grep -q "Snap" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Covers Flatpak" grep -q "Flatpak" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Documents external FFmpeg source-compliance boundary" \
  grep -q 'source and license-compliance boundary' "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Documents that npm runtime excludes FFmpeg executables" \
  grep -q 'excludes their executable payloads' "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Documents Debian's self-contained Node runtime" \
  grep -q 'users do not add NodeSource or install a' "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Documents locked Node provisioning" \
  grep -q 'packages/scripts/locked-node-runtime.mjs' "$SCRIPT_DIR/PUBLISHING_GUIDE.md"
check "Documents installed Node license and provenance checks" \
  bash -c "grep -Fq '/usr/share/doc/elizaos-app/nodejs-LICENSE' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '/usr/share/doc/elizaos-app/nodejs-runtime-provenance.json' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents installed Flatpak Node license and provenance checks" \
  bash -c "grep -Fq '/app/share/licenses/ai.elizaos.App/nodejs-LICENSE' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '/app/share/licenses/ai.elizaos.App/nodejs-runtime-provenance.json' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents project and dependency legal evidence in every system artifact" \
  bash -c "grep -Fq '/usr/share/doc/elizaos-app/elizaos-LICENSE' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '/usr/share/doc/elizaos-app/third-party-notices.json' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '/usr/share/licenses/elizaos-app/THIRD_PARTY_NOTICES.json' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '/app/share/licenses/ai.elizaos.App/third-party-notices.json' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents canonical persistent state for Snap and Flatpak" \
  bash -c "grep -Fq 'ELIZA_STATE_DIR=\$SNAP_USER_COMMON/state/eliza' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '\`\$XDG_STATE_HOME/eliza\`' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'second confined launch' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'second sandbox launch' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents hash-locked, non-isolated PyPI builds" \
  bash -c "grep -Fq -- '--require-hashes --requirement build-requirements.lock' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'python -m build --no-isolation' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'python verify_artifacts.py dist' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents metadata-only Debian control extraction" \
  bash -c "grep -Fq 'git archive --format=tar HEAD packages/app-core/packaging/debian' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'test ! -e debian/node-runtime' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "APT publishing docs use the canonical package and repository" \
    bash -c "grep -Fq 'https://apt.elizaos.ai' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'sudo apt install elizaos-app' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && ! grep -Fq 'https://apt.eliza.ai' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "PyPI docs identify the reusable workflow token boundary" \
  bash -c "grep -Fq 'cannot authenticate this reusable-workflow call path' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'PYPI_TOKEN' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && ! grep -Fq 'PYPI_API_TOKEN' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "PyPI docs reference only the elizaos-app project" \
  bash -c "grep -Fq 'manage/project/elizaos-app/settings/' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && ! grep -Eq 'manage/project/(eliza|elizaos)/' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "APT docs require the full signing fingerprint" \
  bash -c "grep -Fq '40-hex primary-key fingerprint' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq '40-hex primary-key fingerprint' '$SCRIPT_DIR/debian/apt-repo-config/README.md'"
check "Documents APT artifact identity validation and signing-state teardown" \
  bash -c "grep -Fq '\`Package\`, \`Architecture\`, and Debian \`Version\` fields' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'isolated GnuPG and download tree' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents the fail-closed Debian attachment ownership" \
  bash -c "grep -Fq 'never attaches release assets' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'after the installed' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'second \`beta\` upload' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "APT docs describe loopback unlock and retry re-signing" \
  bash -c "grep -Fq 'loopback detached-signature probe' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'Byte-identical retries still re-export' '$SCRIPT_DIR/debian/apt-repo-config/README.md' && grep -Fq 'loopback detached-signature probe' '$REPO_ROOT/packages/os/docs/admin-apt-repo-setup.md' && ! grep -Fq 'pipes it to \`reprepro --ask-passphrase\`' '$REPO_ROOT/packages/os/docs/admin-apt-repo-setup.md'"
check "Snap docs use canonical credentials and supported ACLs" \
  bash -c "grep -Fq 'SNAPCRAFT_STORE_CREDENTIALS' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' '$REPO_ROOT/packages/os/docs/release-secrets-snap.md' && grep -Fq -- '--acls package_access,package_push,package_update,package_release' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' '$REPO_ROOT/packages/os/docs/release-secrets-snap.md' && ! grep -Eq -- '--acls[^[:cntrl:]]*package_(upload|register)' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' '$REPO_ROOT/packages/os/docs/release-secrets-snap.md'"
check "Snap docs require the cross-publisher FFmpeg connection" \
  bash -c "grep -Fq 'sudo snap connect elizaos-app:ffmpeg-2204 ffmpeg-2204:ffmpeg-2204' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' '$REPO_ROOT/packages/os/docs/release-secrets-snap.md' '$SCRIPT_DIR/snap/snapcraft.yaml' && grep -Fq 'auto-connect remains an external release blocker' '$REPO_ROOT/packages/os/docs/release-secrets-snap.md' && ! grep -Fq 'zero-config onboarding' '$SCRIPT_DIR/snap/snapcraft.yaml'"
check "Flathub docs expose the disabled remote-build boundary" \
  bash -c "grep -Fq 'Flathub publication is disabled' '$REPO_ROOT/packages/os/docs/release-secrets-flathub.md' && grep -Fq 'No Flathub credential is currently consumed' '$REPO_ROOT/packages/os/docs/release-secrets-flathub.md' && grep -Fq 'never talks to Flathub' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && ! grep -Fq 'FLATHUB_TOKEN' '$REPO_ROOT/packages/os/docs/release-secrets-checklist.md'"
check "Documents debhelper-owned user-service upgrade state" \
  bash -c "grep -Fq 'dh_installsystemduser' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'verify-maintainer-scripts.sh' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'user session bus' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Documents tag-bound serialized publication and the nightly boundary" \
  bash -c "grep -Fq 'exact validated release tag' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'repository-wide concurrency gate' '$SCRIPT_DIR/PUBLISHING_GUIDE.md' && grep -Fq 'No nightly format exists for these system packages' '$SCRIPT_DIR/PUBLISHING_GUIDE.md'"
check "Has version checklist" grep -q "Version Bumping" "$SCRIPT_DIR/PUBLISHING_GUIDE.md"

echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
bold "════════════════════════════════════════"
bold "  Results: $(green "$PASS passed"), $(red "$FAIL failed"), $(yellow "$SKIP skipped")"
bold "════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
