#!/usr/bin/env bash
# Builds and pushes the digest-pinned Alpha dstack agent image from a clean
# checkout, then writes <out>/image.json for `alpha-dstack.ts render`.
#
# Usage: bash packages/app/deploy/dstack-alpha/build-image.sh \
#          --registry ghcr.io/<org>/eliza-alpha --out /secure/alpha-deploy
#
# Base images come from image.lock.json by digest; the canonical Dockerfile.ci
# build runs through scripts/verify-agent-image.sh, and the result is pushed and
# referenced by its registry digest. Needs Docker with BuildKit and push access.
set -euo pipefail

REGISTRY=""
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$REGISTRY" && -n "$OUT" ]] || { echo "--registry and --out are required" >&2; exit 2; }
[[ "$OUT" = /* ]] || { echo "--out must be an absolute path" >&2; exit 2; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"
case "$OUT/" in
  "$REPO_ROOT"/*) echo "--out must be outside the repository" >&2; exit 2 ;;
esac
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Refusing to build from a modified checkout; commit or stash first." >&2
  exit 1
fi
SOURCE_SHA="$(git rev-parse HEAD)"
HERE="packages/app/deploy/dstack-alpha"
LOCK="$HERE/image.lock.json"
lock() { node -e "const l=require('./$LOCK');process.stdout.write(String($1))"; }

PLATFORM="$(lock l.platform)"
NODE_VERSION="$(lock l.nodeVersion)"
NODE_REF="node:${NODE_VERSION}-slim"
BUN_REF="oven/bun:$(lock l.bunVersion)"
NODE_DIGEST="$(lock "l.baseImages['$NODE_REF']")"
BUN_DIGEST="$(lock "l.baseImages['$BUN_REF']")"
VERIFIER_IMAGE="$(lock l.verifierImage.reference)@$(lock l.verifierImage.digest)"
BASE_TAG="eliza-alpha-base:${SOURCE_SHA}"
TAG="${REGISTRY}:${SOURCE_SHA}"

echo "[alpha-image] building canonical agent image at ${SOURCE_SHA}"
DOCKER_IMAGE="$BASE_TAG" \
DOCKER_BUILD_EXTRA_ARGS="--platform=${PLATFORM}
--build-arg=NODE_VERSION=${NODE_VERSION}
--build-arg=NODE_IMAGE=${NODE_REF}@${NODE_DIGEST}
--build-arg=BUN_IMAGE=${BUN_REF}@${BUN_DIGEST}" \
  bash packages/app/scripts/verify-agent-image.sh --skip-smoke

# verify-agent-image.sh prepares the tree for Docker; restore tracked files so
# the recorded commit still describes every build input.
git checkout -- package.json 2>/dev/null || true

CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
cp "$HERE/Dockerfile" "$HERE/alpha-entry.mjs" packages/app/deploy/confidential-bootstrap.mjs "$CONTEXT/"
echo "[alpha-image] building dstack overlay"
docker build --platform="$PLATFORM" \
  --build-arg "AGENT_IMAGE=$BASE_TAG" \
  --build-arg "VERIFIER_IMAGE=$VERIFIER_IMAGE" \
  --label "org.opencontainers.image.revision=$SOURCE_SHA" \
  --tag "$TAG" "$CONTEXT"
docker push "$TAG"
IMAGE="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$TAG" | grep "^${REGISTRY}@sha256:" | head -n1)"
[[ -n "$IMAGE" ]] || { echo "Pushed image has no registry digest" >&2; exit 1; }
PINS="$(docker run --rm --platform="$PLATFORM" --entrypoint cat "$IMAGE" /opt/eliza-alpha/pins.sha256)"
VERIFIER_SHA="$(printf '%s\n' "$PINS" | awk '$2 == "dstack/dstack-verifier" { print $1 }')"
CONFIG_SHA="$(printf '%s\n' "$PINS" | awk '$2 == "dstack/dstack-verifier.toml" { print $1 }')"
[[ ${#VERIFIER_SHA} -eq 64 && ${#CONFIG_SHA} -eq 64 ]] || { echo "Verifier pins missing" >&2; exit 1; }

mkdir -p "$OUT"
node -e '
const [image, sourceCommit, verifierImage, sha256, configSha256, lock, out] = process.argv.slice(1);
require("node:fs").writeFileSync(out, JSON.stringify({
  schemaVersion: 1, image, sourceCommit, builtAt: new Date().toISOString(),
  verifier: { image: verifierImage, sha256, configSha256 },
  lock: JSON.parse(require("node:fs").readFileSync(lock, "utf8")),
}, null, 2) + "\n", { flag: "wx" });
' "$IMAGE" "$SOURCE_SHA" "$VERIFIER_IMAGE" "$VERIFIER_SHA" "$CONFIG_SHA" "$LOCK" "$OUT/image.json"
echo "[alpha-image] $IMAGE -> $OUT/image.json"
