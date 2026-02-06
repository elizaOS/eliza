#!/bin/bash
# burp-search.sh - Search Burp Suite project files using burpsuite-project-file-parser
# Requires: burpsuite-project-file-parser extension installed in Burp Suite

set -euo pipefail

# Platform-specific default paths
case "$(uname -s)" in
  Darwin)
    _default_java="/Applications/Burp Suite Professional.app/Contents/Resources/jre.bundle/Contents/Home/bin/java"
    _default_jar="/Applications/Burp Suite Professional.app/Contents/Resources/app/burpsuite_pro.jar"
    ;;
  Linux)
    _default_java="/opt/BurpSuiteProfessional/jre/bin/java"
    _default_jar="/opt/BurpSuiteProfessional/burpsuite_pro.jar"
    ;;
  *)
    echo "Warning: Unsupported platform '$(uname -s)'. Set BURP_JAVA and BURP_JAR environment variables." >&2
    _default_java=""
    _default_jar=""
    ;;
esac

JAVA_PATH="${BURP_JAVA:-$_default_java}"
BURP_JAR="${BURP_JAR:-$_default_jar}"

usage() {
  cat <<EOF
Usage: burp-search.sh <project-file> [flags...]

Search and extract data from Burp Suite project files.

Arguments:
  project-file    Path to .burp project file

Flags (combine multiple as needed):
  auditItems                    Extract all security audit findings
  proxyHistory                  Dump all proxy history entries
  siteMap                       Dump all site map entries
  responseHeader='regex'        Search response headers with regex
  responseBody='regex'          Search response bodies with regex

Sub-component filters (for proxyHistory/siteMap):
  proxyHistory.request.headers  Only request headers
  proxyHistory.request.body     Only request body
  proxyHistory.response.headers Only response headers
  proxyHistory.response.body    Only response body
  (same patterns work for siteMap)

Environment variables:
  BURP_JAVA   Path to Java executable (default: Burp's bundled JRE)
  BURP_JAR    Path to burpsuite_pro.jar

Examples:
  burp-search.sh project.burp auditItems
  burp-search.sh project.burp "responseHeader='.*nginx.*'"
  burp-search.sh project.burp proxyHistory.request.headers

Output: JSON objects, one per line
EOF
  exit 1
}

if [ $# -lt 2 ]; then
  usage
fi

PROJECT_FILE="$1"
shift

if [ ! -f "$PROJECT_FILE" ]; then
  echo "Error: Project file not found: $PROJECT_FILE" >&2
  exit 1
fi

if [ -z "$JAVA_PATH" ]; then
  echo "Error: No default Java path for this platform." >&2
  echo "Set BURP_JAVA environment variable to your Java path" >&2
  exit 1
elif [ ! -f "$JAVA_PATH" ]; then
  echo "Error: Java not found at: $JAVA_PATH" >&2
  echo "Set BURP_JAVA environment variable to your Java path" >&2
  exit 1
fi

if [ -z "$BURP_JAR" ]; then
  echo "Error: No default Burp JAR path for this platform." >&2
  echo "Set BURP_JAR environment variable to your burpsuite_pro.jar path" >&2
  exit 1
elif [ ! -f "$BURP_JAR" ]; then
  echo "Error: Burp Suite JAR not found at: $BURP_JAR" >&2
  echo "Set BURP_JAR environment variable to your burpsuite_pro.jar path" >&2
  exit 1
fi

# Execute the search
"$JAVA_PATH" -jar -Djava.awt.headless=true "$BURP_JAR" \
  --project-file="$PROJECT_FILE" \
  "$@"
