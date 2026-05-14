#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage:
  eliza-assistant-handoff.sh [options] [text...]
  printf '%s\n' "remind me at 5" | eliza-assistant-handoff.sh [options]

Options:
  --dry-run          Print the deep link instead of opening it.
  --no-open          Print the deep link instead of opening it.
  --scheme VALUE     URL scheme to open. Defaults to ELIZA_URL_SCHEME or elizaos.
  --source VALUE     Assistant launch source. Defaults to macos-shortcuts.
  --action VALUE     Assistant action metadata. Defaults to ask.
  -h, --help         Show this help.

Shortcuts setup:
  Add a "Run Shell Script" action, pass Shortcut Input to stdin, and call this
  script. The script opens the Eliza desktop URL scheme; the app then hands the
  text to the normal chat/runtime path.
EOF
}

scheme="${ELIZA_URL_SCHEME:-elizaos}"
source="${ELIZA_SHORTCUT_SOURCE:-macos-shortcuts}"
action="${ELIZA_SHORTCUT_ACTION:-ask}"
open_url=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run|--no-open)
      open_url=0
      shift
      ;;
    --scheme)
      shift
      if [ "$#" -eq 0 ]; then
        echo "eliza-assistant-handoff: --scheme requires a value" >&2
        exit 2
      fi
      scheme="$1"
      shift
      ;;
    --source)
      shift
      if [ "$#" -eq 0 ]; then
        echo "eliza-assistant-handoff: --source requires a value" >&2
        exit 2
      fi
      source="$1"
      shift
      ;;
    --action)
      shift
      if [ "$#" -eq 0 ]; then
        echo "eliza-assistant-handoff: --action requires a value" >&2
        exit 2
      fi
      action="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "eliza-assistant-handoff: unknown option: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -gt 0 ]; then
  text="$*"
elif [ -t 0 ]; then
  echo "eliza-assistant-handoff: provide text as arguments or stdin" >&2
  exit 2
else
  text="$(cat)"
fi

if [ -z "$(printf '%s' "$text" | tr -d '[:space:]')" ]; then
  echo "eliza-assistant-handoff: empty text" >&2
  exit 2
fi

urlencode() {
  value="$1"
  if command -v osascript >/dev/null 2>&1; then
    osascript -l JavaScript -e 'function run(argv) { return encodeURIComponent(argv[0] || ""); }' "$value"
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""));' "$value"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""), end="")' "$value"
  else
    echo "eliza-assistant-handoff: need osascript, node, or python3 to URL-encode input" >&2
    exit 2
  fi
}

encoded_text="$(urlencode "$text")"
encoded_source="$(urlencode "$source")"
encoded_action="$(urlencode "$action")"
url="${scheme}://assistant?text=${encoded_text}&source=${encoded_source}&action=${encoded_action}"

if [ "$open_url" -eq 0 ]; then
  printf '%s\n' "$url"
  exit 0
fi

if ! command -v open >/dev/null 2>&1; then
  echo "eliza-assistant-handoff: open(1) is only available on macOS; use --dry-run to inspect the URL" >&2
  exit 2
fi

open "$url"
printf '%s\n' "$url"
