#!/usr/bin/env bash
# Sync an AOSP tree pinned by a profile in aosp.lock.json, failing closed when
# the remote tag, the manifest checkout or a locked project does not match
# the lock.
#
# DRY RUN BY DEFAULT: prints the commands and checks; runs them with --apply.
#
# Usage:
#   sync-aosp.sh --profile NAME [--lock PATH] [--dir DIR] [--jobs N]
#                [--reference MIRROR_DIR] [--apply]
#   sync-aosp.sh --profile NAME [--lock PATH] --mirror [--dir MIRROR_DIR] [--apply]
#
#   --lock PATH       default: packages/os/android/aosp.lock.json, resolved
#                     relative to this script; pass it explicitly after
#                     copying the script and the lock to a builder host
#   --profile NAME    profile key, e.g. cuttlefish
#   --dir DIR         workspace (default /aosp/src/NAME) or, with --mirror,
#                     the shared mirror (default /aosp/mirror)
#   --mirror          create/update a full shared mirror (repo init --mirror)
#   --reference DIR   use a shared mirror as a reference for a workspace
#   --jobs N          parallel jobs (default: nproc)
#
# Lock schema used: profiles.<name>.manifest.{url,tag,tagObject,commit} and
# optional profiles.<name>.projects[].{path,name,commit,tagObject?} and
# profiles.<name>.requiredSourceFiles[]. A project without tagObject is checked
# by commit only.
#
# A successful sync proves only that the locked sources were fetched. It is not
# a build, an image boot or hardware evidence.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY=0
LOCK="$SCRIPT_DIR/../../aosp.lock.json"
PROFILE=""
DIR=""
MIRROR=0
REFERENCE=""
JOBS=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '# %s\n' "$*"; }
print_cmd() {
  local out="" arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_./:=,@%+-]+$ ]]; then out+="$arg "; else out+="$(printf '%q' "$arg") "; fi
  done
  printf '%s\n' "${out% }"
}
run() { print_cmd "$@"; if [[ "$APPLY" == 1 ]]; then "$@"; fi; }
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --lock) LOCK="${2:?--lock needs a path}"; shift 2 ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --mirror) MIRROR=1; shift ;;
    --reference) REFERENCE="${2:?--reference needs a path}"; shift 2 ;;
    --jobs) JOBS="${2:?--jobs needs a number}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument '$1' (see --help)" ;;
  esac
done

[[ -n "$PROFILE" ]] || die "--profile is required"
[[ -f "$LOCK" ]] || die "lock file not found: $LOCK (pass --lock PATH)"
[[ "$PROFILE" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid profile name '$PROFILE'"
if [[ "$MIRROR" == 1 && -n "$REFERENCE" ]]; then
  die "--mirror and --reference are mutually exclusive"
fi

# Emit "key<TAB>value" lines for the profile; projects as
# project<TAB>path<TAB>name<TAB>tagObject<TAB>commit. Missing optional fields
# are printed as "-" because bash `read` collapses consecutive tab separators.
read_lock() {
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg p "$PROFILE" '
      .profiles[$p] as $x
      | if $x == null then error("profile not found: " + $p) else . end
      | ["url", $x.manifest.url], ["tag", $x.manifest.tag],
        ["tagObject", $x.manifest.tagObject], ["commit", $x.manifest.commit],
        (($x.projects // [])[] | ["project", (.path // "-"), (.name // "-"), (.tagObject // "-"), (.commit // "-")]),
        (($x.requiredSourceFiles // [])[] | ["required", .])
      | @tsv' "$LOCK"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$LOCK" "$PROFILE" <<'PY'
import json, sys
lock, name = sys.argv[1], sys.argv[2]
x = json.load(open(lock)).get("profiles", {}).get(name)
if x is None:
    sys.exit("profile not found: " + name)
m = x["manifest"]
for k in ("url", "tag", "tagObject", "commit"):
    print(f"{k}\t{m[k]}")
for p in x.get("projects", []):
    print("\t".join(["project"] + [p.get(k) or "-" for k in ("path", "name", "tagObject", "commit")]))
for f in x.get("requiredSourceFiles", []):
    print(f"required\t{f}")
PY
  else
    die "need jq or python3 to read the lock file"
  fi
}

LOCK_DATA="$(read_lock)" || die "could not read profile '$PROFILE' from $LOCK"
URL="" TAG="" TAG_OBJECT="" COMMIT=""
PROJECTS=()
REQUIRED=()
while IFS=$'\t' read -r key a b c d; do
  case "$key" in
    url) URL="$a" ;;
    tag) TAG="$a" ;;
    tagObject) TAG_OBJECT="$a" ;;
    commit) COMMIT="$a" ;;
    project) PROJECTS+=("$a"$'\t'"$b"$'\t'"$c"$'\t'"$d") ;;
    required) REQUIRED+=("$a") ;;
  esac
done <<<"$LOCK_DATA"

HEX40='^[0-9a-f]{40}$'
[[ "$URL" =~ ^https://[A-Za-z0-9./_-]+$ ]] || die "lock manifest.url must be an https URL, got '$URL'"
[[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] || die "lock manifest.tag is invalid: '$TAG'"
[[ "$TAG_OBJECT" =~ $HEX40 ]] || die "lock manifest.tagObject must be a 40-hex SHA-1"
[[ "$COMMIT" =~ $HEX40 ]] || die "lock manifest.commit must be a 40-hex SHA-1"

if [[ -z "$JOBS" ]]; then
  JOBS="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)"
fi
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || die "--jobs must be a positive integer"
if [[ -z "$DIR" ]]; then
  if [[ "$MIRROR" == 1 ]]; then DIR=/aosp/mirror; else DIR="/aosp/src/$PROFILE"; fi
fi

if [[ "$APPLY" == 1 ]]; then
  for tool in git repo; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
else
  note "DRY RUN: printing commands and checks only. Re-run with --apply to execute."
fi

note "profile=$PROFILE url=$URL"
note "locked tag=$TAG tagObject=$TAG_OBJECT commit=$COMMIT"
note "mode=$([[ "$MIRROR" == 1 ]] && echo mirror || echo workspace) dir=$DIR jobs=$JOBS"

# 1. The remote tag must still point at the locked tag object and commit.
note "check: remote refs/tags/$TAG == $TAG_OBJECT and refs/tags/$TAG^{} == $COMMIT"
run git ls-remote "$URL" "refs/tags/$TAG" "refs/tags/$TAG^{}"
if [[ "$APPLY" == 1 ]]; then
  remote="$(git ls-remote "$URL" "refs/tags/$TAG" "refs/tags/$TAG^{}")"
  remote_tag="$(awk -v r="refs/tags/$TAG" '$2==r{print $1}' <<<"$remote")"
  remote_commit="$(awk -v r="refs/tags/$TAG^{}" '$2==r{print $1}' <<<"$remote")"
  [[ "$remote_tag" == "$TAG_OBJECT" ]] ||
    die "remote tag object '$remote_tag' != locked $TAG_OBJECT; refusing to sync"
  [[ "$remote_commit" == "$COMMIT" ]] ||
    die "remote tag commit '$remote_commit' != locked $COMMIT; refusing to sync"
fi

# 2. repo init at the locked tag.
run mkdir -p "$DIR"
init=(repo init -u "$URL" -b "refs/tags/$TAG")
if [[ "$MIRROR" == 1 ]]; then
  init+=(--mirror)
else
  init+=(--partial-clone --clone-filter=blob:limit=10M)
  if [[ -n "$REFERENCE" ]]; then init+=(--reference="$REFERENCE"); fi
fi
print_cmd cd "$DIR"
if [[ "$APPLY" == 1 ]]; then cd "$DIR"; fi
run "${init[@]}"

# 3. The manifest checkout must be the locked commit before any sync.
note "check: .repo/manifests HEAD == $COMMIT"
run git -C .repo/manifests rev-parse HEAD
if [[ "$APPLY" == 1 ]]; then
  head="$(git -C .repo/manifests rev-parse HEAD)"
  [[ "$head" == "$COMMIT" ]] ||
    die "manifest checkout $head != locked $COMMIT; refusing to sync"
fi

# 4. Sync.
if [[ "$MIRROR" == 1 ]]; then
  # A mirror keeps all refs and tags so workspaces can reference any release.
  run repo sync -j"$JOBS" --optimized-fetch --fail-fast
else
  run repo sync -c -j"$JOBS" --no-tags --optimized-fetch --fail-fast
fi

# 5. Locked projects must match after sync.
for entry in ${PROJECTS[@]+"${PROJECTS[@]}"}; do
  IFS=$'\t' read -r p_path p_name p_tag_object p_commit <<<"$entry"
  [[ "$p_path" != - && "$p_name" != - ]] || die "lock project entries need path and name"
  [[ "$p_commit" =~ $HEX40 ]] || die "lock project $p_path commit is not a 40-hex SHA-1"
  if [[ "$p_tag_object" != - && ! "$p_tag_object" =~ $HEX40 ]]; then
    die "lock project $p_path tagObject is not a 40-hex SHA-1"
  fi
  if [[ "$MIRROR" == 1 && "$p_tag_object" == - ]]; then
    note "check: mirror $p_name.git contains commit $p_commit"
    run git --git-dir="$p_name.git" cat-file -e "$p_commit^{commit}"
  elif [[ "$MIRROR" == 1 ]]; then
    note "check: mirror $p_name.git refs/tags/$TAG == $p_tag_object, ^{commit} == $p_commit"
    run git --git-dir="$p_name.git" rev-parse "refs/tags/$TAG" "refs/tags/$TAG^{commit}"
    if [[ "$APPLY" == 1 ]]; then
      got_tag="$(git --git-dir="$p_name.git" rev-parse "refs/tags/$TAG")"
      got_commit="$(git --git-dir="$p_name.git" rev-parse "refs/tags/$TAG^{commit}")"
      [[ "$got_tag" == "$p_tag_object" ]] || die "mirror $p_name tag $got_tag != locked $p_tag_object"
      [[ "$got_commit" == "$p_commit" ]] || die "mirror $p_name commit $got_commit != locked $p_commit"
    fi
  else
    note "check: $p_path HEAD == $p_commit"
    run git -C "$p_path" rev-parse HEAD
    if [[ "$APPLY" == 1 ]]; then
      got="$(git -C "$p_path" rev-parse HEAD)"
      [[ "$got" == "$p_commit" ]] || die "project $p_path at $got != locked $p_commit"
    fi
  fi
done

if [[ "$MIRROR" != 1 ]]; then
  for f in ${REQUIRED[@]+"${REQUIRED[@]}"}; do
    note "check: required source file exists: $f"
    if [[ "$APPLY" == 1 && ! -f "$f" ]]; then
      die "required source file missing after sync: $f"
    fi
  done
fi

if [[ "$APPLY" == 1 ]]; then
  note "sync matches lock profile $PROFILE ($TAG @ $COMMIT)"
else
  note "dry run complete; nothing was fetched"
fi
