#!/bin/bash

# Firebase APK Security Scanner v1.0 (macOS Compatible)
# Comprehensive Firebase misconfiguration detection
# Enhanced extraction from all possible locations

set -uo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
# CYAN intentionally unused but kept for consistency with other color definitions
# shellcheck disable=SC2034
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Configuration
TIMEOUT_SECONDS=10
USER_AGENT="Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36"
WRITE_TEST_PATH="_firebase_security_test_$(date +%s)"

# Output directories
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_DIR="firebase_scan_${TIMESTAMP}"
DECOMPILED_DIR="${OUTPUT_DIR}/decompiled"
RESULTS_DIR="${OUTPUT_DIR}/results"
REPORT_FILE="${OUTPUT_DIR}/scan_report.txt"
JSON_REPORT="${OUTPUT_DIR}/scan_report.json"

# Counters
TOTAL_APKS=0
VULNERABLE_APKS=0
TOTAL_VULNS=0

# Common Cloud Function names to enumerate
COMMON_FUNCTIONS="addMessage sendMessage createUser deleteUser updateUser getUser getUsers login logout register signup signUp authenticate verify verifyEmail resetPassword changePassword sendNotification sendEmail processPayment createOrder getOrders updateOrder deleteOrder uploadFile getFile generateToken validateToken refreshToken getData setData syncData backup restore export import webhook callback api admin debug test healthcheck status createProfile updateProfile deleteProfile getProfile subscribe unsubscribe notify push analytics"

print_banner() {
  echo ""
  echo "╔═══════════════════════════════════════════════════════════╗"
  echo "║      Firebase APK Security Scanner v1.0                   ║"
  echo "║  Auth | Database | Storage | Functions | Remote Config   ║"
  echo "║         For Authorized Security Research Only             ║"
  echo "╚═══════════════════════════════════════════════════════════╝"
  echo ""
}

# All log functions write to stderr so they don't interfere with function return values
log_info() { printf "${BLUE}[INFO]${NC} %s\n" "$1" >&2; }
log_success() { printf "${GREEN}[+]${NC} %s\n" "$1" >&2; }
log_warning() { printf "${YELLOW}[!]${NC} %s\n" "$1" >&2; }
log_error() { printf "${RED}[-]${NC} %s\n" "$1" >&2; }
log_vuln() {
  printf "${RED}[VULN]${NC} %s\n" "$1" >&2
  TOTAL_VULNS=$((TOTAL_VULNS + 1))
}
log_section() { printf "${MAGENTA}[*]${NC} %s\n" "$1" >&2; }

check_dependencies() {
  log_info "Checking dependencies..."
  local missing=""

  for cmd in apktool curl jq grep unzip sed awk strings; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing="$missing $cmd"
    fi
  done

  if [ -n "$missing" ]; then
    log_error "Missing dependencies:$missing"
    echo "Install with:"
    echo "  macOS: brew install apktool curl jq binutils"
    echo "  Ubuntu/Debian: sudo apt install apktool curl jq unzip binutils"
    exit 1
  fi

  log_success "All dependencies found"
}

setup_directories() {
  mkdir -p "$DECOMPILED_DIR" "$RESULTS_DIR"
  log_info "Output directory: $OUTPUT_DIR"
}

# Helper: Convert string to JSON array
to_json_array() {
  local input="$1"
  if [ -z "$input" ]; then
    echo "[]"
    return
  fi
  echo "$input" | tr ' ' '\n' | grep -v '^$' | sort -u | jq -R . | jq -s .
}

# Extract strings directly from raw APK (DEX files, etc.)
extract_from_raw_apk() {
  local apk_path="$1"
  local temp_dir="$2"

  log_info "Extracting strings from raw APK/DEX files..."

  local raw_strings=""

  # Extract and search DEX files
  local dex_dir="${temp_dir}/_raw_dex"
  mkdir -p "$dex_dir"

  # Unzip DEX files
  unzip -q -o "$apk_path" "*.dex" -d "$dex_dir" 2>/dev/null || true
  unzip -q -o "$apk_path" "assets/*" -d "$dex_dir" 2>/dev/null || true
  unzip -q -o "$apk_path" "res/raw/*" -d "$dex_dir" 2>/dev/null || true

  # Search in DEX files using strings command
  for dex_file in "$dex_dir"/*.dex; do
    [ -f "$dex_file" ] || continue
    raw_strings="$raw_strings $(strings "$dex_file" 2>/dev/null || true)"
  done

  # Search in assets (for hybrid apps)
  if [ -d "${dex_dir}/assets" ]; then
    while IFS= read -r asset_file; do
      raw_strings="$raw_strings $(strings "$asset_file" 2>/dev/null || true)"
    done < <(find "${dex_dir}/assets" -type f 2>/dev/null)
  fi

  # Search in raw resources
  if [ -d "${dex_dir}/res/raw" ]; then
    while IFS= read -r raw_file; do
      raw_strings="$raw_strings $(cat "$raw_file" 2>/dev/null || true)"
    done < <(find "${dex_dir}/res/raw" -type f 2>/dev/null)
  fi

  # Cleanup
  rm -rf "$dex_dir"

  echo "$raw_strings"
}

# Comprehensive Firebase config extraction
extract_firebase_config() {
  local apk_dir="$1"
  local apk_path="$2"
  local config_file="${apk_dir}/firebase_config.json"

  local project_ids=""
  local db_urls=""
  local storage_buckets=""
  local api_keys=""
  local auth_domains=""
  local function_names=""
  local messaging_sender_ids=""

  log_info "Phase 1: Searching decompiled resources..."

  #=========================================================================
  # PHASE 1: google-services.json
  #=========================================================================
  local gs_json
  gs_json=$(find "$apk_dir" -name "google-services.json" 2>/dev/null | head -1)
  if [ -n "$gs_json" ] && [ -f "$gs_json" ]; then
    log_info "Found google-services.json"

    local proj_id
    proj_id=$(jq -r '.project_info.project_id // empty' "$gs_json" 2>/dev/null || true)
    [ -n "$proj_id" ] && project_ids="$project_ids $proj_id"

    local fb_url
    fb_url=$(jq -r '.project_info.firebase_url // empty' "$gs_json" 2>/dev/null || true)
    [ -n "$fb_url" ] && db_urls="$db_urls $fb_url"

    local bucket
    bucket=$(jq -r '.project_info.storage_bucket // empty' "$gs_json" 2>/dev/null || true)
    [ -n "$bucket" ] && storage_buckets="$storage_buckets $bucket"

    local api_key
    api_key=$(jq -r '.client[0].api_key[0].current_key // empty' "$gs_json" 2>/dev/null || true)
    [ -n "$api_key" ] && api_keys="$api_keys $api_key"

    local sender_id
    sender_id=$(jq -r '.project_info.project_number // empty' "$gs_json" 2>/dev/null || true)
    [ -n "$sender_id" ] && messaging_sender_ids="$messaging_sender_ids $sender_id"
  fi

  #=========================================================================
  # PHASE 2: All XML resource files (strings.xml, values.xml, etc.)
  #=========================================================================
  log_info "Phase 2: Searching XML resources..."

  # Find all XML files in res/values*
  while IFS= read -r xml_file; do
    [ -f "$xml_file" ] || continue

    # Firebase Database URLs
    local xml_db
    xml_db=$(grep -oE 'https://[^"<>]+\.firebaseio\.com[^"<>]*' "$xml_file" 2>/dev/null | tr '\n' ' ' || true)
    db_urls="$db_urls $xml_db"

    # Storage buckets (appspot format)
    local xml_bucket
    xml_bucket=$(grep -oE '[a-zA-Z0-9_-]+\.appspot\.com' "$xml_file" 2>/dev/null | tr '\n' ' ' || true)
    storage_buckets="$storage_buckets $xml_bucket"

    # API Keys from XML
    local xml_keys
    xml_keys=$(grep -oE 'AIza[A-Za-z0-9_-]{35}' "$xml_file" 2>/dev/null | tr '\n' ' ' || true)
    api_keys="$api_keys $xml_keys"

    # Project IDs from firebase_database_url or project_id entries
    local xml_proj
    xml_proj=$(grep -oE 'https://([a-zA-Z0-9_-]+)\.firebaseio\.com' "$xml_file" 2>/dev/null | sed 's|https://||;s|\.firebaseio\.com||' | tr '\n' ' ' || true)
    project_ids="$project_ids $xml_proj"

    # GCM/FCM Sender IDs
    local xml_sender
    xml_sender=$(grep -oE 'gcm_defaultSenderId[^>]*>[0-9]+' "$xml_file" 2>/dev/null | grep -oE '[0-9]{10,}' | tr '\n' ' ' || true)
    messaging_sender_ids="$messaging_sender_ids $xml_sender"

    # Auth domains
    local xml_auth
    xml_auth=$(grep -oE '[a-zA-Z0-9_-]+\.firebaseapp\.com' "$xml_file" 2>/dev/null | tr '\n' ' ' || true)
    auth_domains="$auth_domains $xml_auth"
  done < <(find "$apk_dir" -path "*/res/values*" -name "*.xml" 2>/dev/null)

  #=========================================================================
  # PHASE 3: AndroidManifest.xml
  #=========================================================================
  log_info "Phase 3: Searching AndroidManifest.xml..."

  local manifest="${apk_dir}/AndroidManifest.xml"
  if [ -f "$manifest" ]; then
    local manifest_keys
    manifest_keys=$(grep -oE 'AIza[A-Za-z0-9_-]{35}' "$manifest" 2>/dev/null | tr '\n' ' ' || true)
    api_keys="$api_keys $manifest_keys"

    # Note: Project IDs in manifest are extracted via other patterns
  fi

  #=========================================================================
  # PHASE 4: Assets folder (hybrid apps - React Native, Flutter, Cordova)
  #=========================================================================
  log_info "Phase 4: Searching assets (hybrid app configs)..."

  local assets_dir="${apk_dir}/assets"
  if [ -d "$assets_dir" ]; then
    # Search all files in assets
    while IFS= read -r asset_file; do
      [ -f "$asset_file" ] || continue

      # Firebase URLs
      local asset_db
      asset_db=$(grep -oE 'https://[a-zA-Z0-9_-]+\.firebaseio\.com' "$asset_file" 2>/dev/null | tr '\n' ' ' || true)
      db_urls="$db_urls $asset_db"

      # Storage buckets (both formats)
      local asset_bucket
      asset_bucket=$(grep -oE '[a-zA-Z0-9_-]+\.appspot\.com' "$asset_file" 2>/dev/null | tr '\n' ' ' || true)
      storage_buckets="$storage_buckets $asset_bucket"

      # gs:// format storage URLs
      local asset_gs
      asset_gs=$(grep -oE 'gs://[a-zA-Z0-9_-]+' "$asset_file" 2>/dev/null | sed 's|gs://||' | tr '\n' ' ' || true)
      storage_buckets="$storage_buckets $asset_gs"

      # API Keys
      local asset_keys
      asset_keys=$(grep -oE 'AIza[A-Za-z0-9_-]{35}' "$asset_file" 2>/dev/null | tr '\n' ' ' || true)
      api_keys="$api_keys $asset_keys"

      # Auth domains
      local asset_auth
      asset_auth=$(grep -oE '[a-zA-Z0-9_-]+\.firebaseapp\.com' "$asset_file" 2>/dev/null | tr '\n' ' ' || true)
      auth_domains="$auth_domains $asset_auth"

      # Cloud Functions URLs
      local asset_funcs
      asset_funcs=$(grep -oE '[a-z0-9-]+\.cloudfunctions\.net/[a-zA-Z0-9_-]+' "$asset_file" 2>/dev/null | sed 's|.*cloudfunctions.net/||' | tr '\n' ' ' || true)
      function_names="$function_names $asset_funcs"

      # Firestore project references
      local asset_proj
      asset_proj=$(grep -oE 'projectId["\x27: ]+[a-zA-Z0-9_-]+' "$asset_file" 2>/dev/null | sed 's/.*["\x27: ]//' | tr '\n' ' ' || true)
      project_ids="$project_ids $asset_proj"
    done < <(find "$assets_dir" -type f 2>/dev/null)

    # Specifically check for common hybrid app config files
    for config_name in "firebase_config.json" "config.json" "app.config.json" "firebase.json" "google-services.json" "firebaseConfig.js" "firebase-config.js"; do
      local config_path
      config_path=$(find "$assets_dir" -name "$config_name" 2>/dev/null | head -1)
      if [ -n "$config_path" ] && [ -f "$config_path" ]; then
        log_info "Found hybrid app config: $config_name"

        local cfg_keys
        cfg_keys=$(grep -oE 'AIza[A-Za-z0-9_-]{35}' "$config_path" 2>/dev/null | tr '\n' ' ' || true)
        api_keys="$api_keys $cfg_keys"

        local cfg_db
        cfg_db=$(grep -oE 'https://[a-zA-Z0-9_-]+\.firebaseio\.com' "$config_path" 2>/dev/null | tr '\n' ' ' || true)
        db_urls="$db_urls $cfg_db"
      fi
    done

    # Flutter specific: look in flutter_assets
    if [ -d "${assets_dir}/flutter_assets" ]; then
      log_info "Flutter app detected - searching flutter_assets..."
      while IFS= read -r flutter_file; do
        local flutter_keys
        flutter_keys=$(strings "$flutter_file" 2>/dev/null | grep -oE 'AIza[A-Za-z0-9_-]{35}' | tr '\n' ' ' || true)
        api_keys="$api_keys $flutter_keys"

        local flutter_db
        flutter_db=$(strings "$flutter_file" 2>/dev/null | grep -oE 'https://[a-zA-Z0-9_-]+\.firebaseio\.com' | tr '\n' ' ' || true)
        db_urls="$db_urls $flutter_db"
      done < <(find "${assets_dir}/flutter_assets" -type f 2>/dev/null)
    fi
  fi

  #=========================================================================
  # PHASE 5: res/raw folder
  #=========================================================================
  log_info "Phase 5: Searching res/raw resources..."

  local raw_dir="${apk_dir}/res/raw"
  if [ -d "$raw_dir" ]; then
    while IFS= read -r raw_file; do
      local raw_keys
      raw_keys=$(grep -oE 'AIza[A-Za-z0-9_-]{35}' "$raw_file" 2>/dev/null | tr '\n' ' ' || true)
      api_keys="$api_keys $raw_keys"

      local raw_db
      raw_db=$(grep -oE 'https://[a-zA-Z0-9_-]+\.firebaseio\.com' "$raw_file" 2>/dev/null | tr '\n' ' ' || true)
      db_urls="$db_urls $raw_db"
    done < <(find "$raw_dir" -type f 2>/dev/null)
  fi

  #=========================================================================
  # PHASE 6: Smali code (decompiled DEX)
  #=========================================================================
  log_info "Phase 6: Searching smali code..."

  local smali_dirs
  smali_dirs=$(find "$apk_dir" -type d -name "smali*" 2>/dev/null)
  for smali_dir in $smali_dirs; do
    [ -d "$smali_dir" ] || continue

    # Search for const-string declarations with Firebase URLs
    local smali_db
    smali_db=$(grep -r -h "const-string" "$smali_dir" 2>/dev/null | grep -oE 'https://[a-zA-Z0-9_-]+\.firebaseio\.com' | tr '\n' ' ' || true)
    db_urls="$db_urls $smali_db"

    # gs:// storage references in smali
    local smali_gs
    smali_gs=$(grep -r -h "gs://" "$smali_dir" 2>/dev/null | grep -oE 'gs://[a-zA-Z0-9_-]+' | sed 's|gs://||' | tr '\n' ' ' || true)
    storage_buckets="$storage_buckets $smali_gs"

    # API Keys in smali
    local smali_keys
    smali_keys=$(grep -r -h 'AIza[A-Za-z0-9_-]\{35\}' "$smali_dir" 2>/dev/null | grep -oE 'AIza[A-Za-z0-9_-]{35}' | tr '\n' ' ' || true)
    api_keys="$api_keys $smali_keys"

    # Cloud Functions URLs
    local smali_funcs
    smali_funcs=$(grep -r -h "cloudfunctions.net" "$smali_dir" 2>/dev/null | grep -oE 'cloudfunctions\.net/[a-zA-Z0-9_-]+' | sed 's|cloudfunctions.net/||' | tr '\n' ' ' || true)
    function_names="$function_names $smali_funcs"

    # httpsCallable function names
    local smali_callable
    smali_callable=$(grep -r -h "httpsCallable" "$smali_dir" 2>/dev/null | grep -oE '"[a-zA-Z0-9_-]+"' | tr -d '"' | tr '\n' ' ' || true)
    function_names="$function_names $smali_callable"
  done

  #=========================================================================
  # PHASE 7: Raw APK extraction (strings from DEX)
  #=========================================================================
  if [ -n "$apk_path" ] && [ -f "$apk_path" ]; then
    log_info "Phase 7: Extracting strings from raw APK..."

    local raw_strings
    raw_strings=$(extract_from_raw_apk "$apk_path" "$apk_dir")

    # Extract from raw strings
    local raw_db
    raw_db=$(echo "$raw_strings" | grep -oE 'https://[a-zA-Z0-9_-]+\.firebaseio\.com' | tr '\n' ' ' || true)
    db_urls="$db_urls $raw_db"

    local raw_gs
    raw_gs=$(echo "$raw_strings" | grep -oE 'gs://[a-zA-Z0-9_-]+' | sed 's|gs://||' | tr '\n' ' ' || true)
    storage_buckets="$storage_buckets $raw_gs"

    local raw_bucket
    raw_bucket=$(echo "$raw_strings" | grep -oE '[a-zA-Z0-9_-]+\.appspot\.com' | tr '\n' ' ' || true)
    storage_buckets="$storage_buckets $raw_bucket"

    local raw_keys
    raw_keys=$(echo "$raw_strings" | grep -oE 'AIza[A-Za-z0-9_-]{35}' | tr '\n' ' ' || true)
    api_keys="$api_keys $raw_keys"

    local raw_auth
    raw_auth=$(echo "$raw_strings" | grep -oE '[a-zA-Z0-9_-]+\.firebaseapp\.com' | tr '\n' ' ' || true)
    auth_domains="$auth_domains $raw_auth"

    local raw_funcs
    raw_funcs=$(echo "$raw_strings" | grep -oE '[a-z0-9-]+\.cloudfunctions\.net' | tr '\n' ' ' || true)
    # Extract project IDs from function URLs
    for func_url in $raw_funcs; do
      local func_proj
      func_proj=$(echo "$func_url" | sed 's|\.cloudfunctions\.net||' | sed 's|-[a-z0-9]*$||' || true)
      [ -n "$func_proj" ] && project_ids="$project_ids $func_proj"
    done
  fi

  #=========================================================================
  # PHASE 8: Deep recursive search (fallback)
  #=========================================================================
  log_info "Phase 8: Deep recursive search..."

  # Catch anything we might have missed
  local deep_db
  deep_db=$(grep -r -oh 'https://[a-zA-Z0-9_-]*\.firebaseio\.com' "$apk_dir" 2>/dev/null | sort -u | tr '\n' ' ' || true)
  db_urls="$db_urls $deep_db"

  local deep_gs
  deep_gs=$(grep -r -oh 'gs://[a-zA-Z0-9_-]*' "$apk_dir" 2>/dev/null | sed 's|gs://||' | sort -u | tr '\n' ' ' || true)
  storage_buckets="$storage_buckets $deep_gs"

  local deep_bucket
  deep_bucket=$(grep -r -ohE '[a-zA-Z0-9_-]+\.appspot\.com' "$apk_dir" 2>/dev/null | sort -u | tr '\n' ' ' || true)
  storage_buckets="$storage_buckets $deep_bucket"

  local deep_keys
  deep_keys=$(grep -r -ohE 'AIza[A-Za-z0-9_-]{35}' "$apk_dir" 2>/dev/null | sort -u | tr '\n' ' ' || true)
  api_keys="$api_keys $deep_keys"

  local deep_auth
  deep_auth=$(grep -r -ohE '[a-zA-Z0-9_-]+\.firebaseapp\.com' "$apk_dir" 2>/dev/null | sort -u | tr '\n' ' ' || true)
  auth_domains="$auth_domains $deep_auth"

  local deep_firestore
  deep_firestore=$(grep -r -oh 'firestore\.googleapis\.com/v1/projects/[a-zA-Z0-9_-]*' "$apk_dir" 2>/dev/null | sed 's|.*projects/||' | sort -u | tr '\n' ' ' || true)
  project_ids="$project_ids $deep_firestore"

  local deep_funcs_url
  deep_funcs_url=$(grep -r -ohE '[a-z0-9-]+\.cloudfunctions\.net/[a-zA-Z0-9_-]+' "$apk_dir" 2>/dev/null | sort -u || true)
  for func_url in $deep_funcs_url; do
    local fname
    fname="${func_url##*cloudfunctions.net/}"
    [ -n "$fname" ] && function_names="$function_names $fname"
  done

  #=========================================================================
  # Derive project IDs from other extracted data
  #=========================================================================
  log_info "Deriving project IDs from extracted URLs..."

  # From database URLs
  for url in $db_urls; do
    local proj
    proj="${url#https://}"
    proj="${proj%%.*}"
    [ -n "$proj" ] && [ "$proj" != "$url" ] && project_ids="$project_ids $proj"
  done

  # From auth domains
  for domain in $auth_domains; do
    local proj
    proj="${domain%.firebaseapp.com}"
    [ -n "$proj" ] && project_ids="$project_ids $proj"
  done

  # From storage buckets
  for bucket in $storage_buckets; do
    local proj
    proj="${bucket%.appspot.com}"
    [ -n "$proj" ] && project_ids="$project_ids $proj"
  done

  #=========================================================================
  # Clean up and deduplicate
  #=========================================================================
  log_info "Deduplicating results..."

  project_ids=$(echo "$project_ids" | tr ' ' '\n' | grep -v '^$' | grep -v '^https' | sort -u | tr '\n' ' ')
  db_urls=$(echo "$db_urls" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
  storage_buckets=$(echo "$storage_buckets" | tr ' ' '\n' | grep -v '^$' | grep -v '^gs$' | sort -u | tr '\n' ' ')
  api_keys=$(echo "$api_keys" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
  auth_domains=$(echo "$auth_domains" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
  function_names=$(echo "$function_names" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
  messaging_sender_ids=$(echo "$messaging_sender_ids" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')

  # Build JSON config
  cat >"$config_file" <<EOF
{
    "project_ids": $(to_json_array "$project_ids"),
    "database_urls": $(to_json_array "$db_urls"),
    "storage_buckets": $(to_json_array "$storage_buckets"),
    "api_keys": $(to_json_array "$api_keys"),
    "auth_domains": $(to_json_array "$auth_domains"),
    "function_names": $(to_json_array "$function_names"),
    "messaging_sender_ids": $(to_json_array "$messaging_sender_ids")
}
EOF

  echo "$config_file"
}

#=============================================================================
# FIREBASE AUTHENTICATION TESTS
#=============================================================================

test_auth_signup_enabled() {
  local api_key="$1"
  local result_file="$2"

  log_info "Testing Auth: Open Signup via Identity Toolkit API"

  local test_email
  test_email="firebasescanner_test_$(date +%s)@test-domain-nonexistent.com"
  local test_password="TestPassword123!"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: application/json" \
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${api_key}" \
    -d "{\"email\":\"${test_email}\",\"password\":\"${test_password}\",\"returnSecureToken\":true}" \
    2>/dev/null || echo '{"error":{}}')

  if echo "$response" | grep -q '"idToken"'; then
    log_vuln "AUTH SIGNUP OPEN: Can create accounts via API"
    echo "VULNERABLE" >"$result_file"

    local id_token
    id_token=$(echo "$response" | jq -r '.idToken // empty' 2>/dev/null || true)
    echo "Created test account: $test_email" >>"$result_file"
    echo "ID_TOKEN:$id_token" >>"$result_file"

    # Cleanup
    if [ -n "$id_token" ]; then
      curl -s --max-time 5 \
        -X POST \
        -H "Content-Type: application/json" \
        "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${api_key}" \
        -d "{\"idToken\":\"${id_token}\"}" >/dev/null 2>&1 || true
    fi
    return 0
  elif echo "$response" | grep -q "ADMIN_ONLY_OPERATION\|OPERATION_NOT_ALLOWED"; then
    log_success "Auth signup properly restricted"
    echo "PROTECTED" >"$result_file"
  elif echo "$response" | grep -q "API_KEY_INVALID\|API key not valid"; then
    log_warning "Invalid API key"
    echo "INVALID_KEY" >"$result_file"
  else
    log_warning "Auth signup status unclear"
    echo "UNKNOWN" >"$result_file"
  fi

  return 1
}

test_auth_anonymous() {
  local api_key="$1"
  local result_file="$2"

  log_info "Testing Auth: Anonymous Sign-in"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: application/json" \
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${api_key}" \
    -d '{"returnSecureToken":true}' \
    2>/dev/null || echo '{"error":{}}')

  if echo "$response" | grep -q '"idToken"'; then
    log_vuln "ANONYMOUS AUTH ENABLED: Can sign in anonymously"
    echo "VULNERABLE" >"$result_file"

    local id_token
    id_token=$(echo "$response" | jq -r '.idToken // empty' 2>/dev/null || true)
    local local_id
    local_id=$(echo "$response" | jq -r '.localId // empty' 2>/dev/null || true)
    echo "Anonymous UID: $local_id" >>"$result_file"
    echo "ID_TOKEN:$id_token" >>"$result_file"
    return 0
  else
    log_success "Anonymous auth disabled or restricted"
    echo "PROTECTED" >"$result_file"
  fi

  return 1
}

test_auth_email_enumeration() {
  local api_key="$1"
  local result_file="$2"

  log_info "Testing Auth: Email Enumeration"

  local fake_email
  fake_email="definitely_not_exists_$(date +%s)@nonexistent-domain-test.com"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: application/json" \
    "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${api_key}" \
    -d "{\"identifier\":\"${fake_email}\",\"continueUri\":\"https://localhost\"}" \
    2>/dev/null || echo '{"error":{}}')

  if echo "$response" | grep -q '"registered"'; then
    log_vuln "EMAIL ENUMERATION: API reveals if emails are registered"
    echo "VULNERABLE" >"$result_file"
    return 0
  fi

  log_success "Email enumeration protected"
  echo "PROTECTED" >"$result_file"
  return 1
}

#=============================================================================
# DATABASE TESTS
#=============================================================================

test_rtdb_read() {
  local db_url="$1"
  local result_file="$2"

  # Normalize URL
  db_url="${db_url%/}"
  if ! echo "$db_url" | grep -q '^https://'; then
    db_url="https://$db_url"
  fi

  log_info "Testing RTDB read: $db_url"

  local response
  local http_code
  local body

  response=$(curl -s -w "\nHTTP_CODE:%{http_code}" --max-time "$TIMEOUT_SECONDS" \
    -H "User-Agent: $USER_AGENT" \
    "${db_url}/.json" 2>/dev/null || echo -e "\nHTTP_CODE:000")

  http_code=$(echo "$response" | grep "HTTP_CODE:" | sed 's/HTTP_CODE://')
  body=$(echo "$response" | grep -v "HTTP_CODE:")

  if [ "$http_code" = "200" ] && [ "$body" != "null" ] && [ -n "$body" ]; then
    log_vuln "RTDB READ OPEN: $db_url"
    echo "VULNERABLE" >"$result_file"
    echo "$body" | head -c 500 >>"$result_file"
    return 0
  elif echo "$body" | grep -q "Permission denied"; then
    log_success "RTDB read protected"
    echo "PROTECTED" >"$result_file"
  else
    echo "UNKNOWN:$http_code" >"$result_file"
  fi

  return 1
}

test_rtdb_write() {
  local db_url="$1"
  local result_file="$2"

  db_url="${db_url%/}"
  if ! echo "$db_url" | grep -q '^https://'; then
    db_url="https://$db_url"
  fi

  log_info "Testing RTDB write: $db_url"

  local test_data
  test_data="{\"security_test\":\"firebase_scanner\",\"timestamp\":$(date +%s)}"
  local response

  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X PUT \
    -H "Content-Type: application/json" \
    -H "User-Agent: $USER_AGENT" \
    -d "$test_data" \
    "${db_url}/${WRITE_TEST_PATH}.json" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q "security_test"; then
    log_vuln "RTDB WRITE OPEN: $db_url"
    echo "VULNERABLE" >"$result_file"
    curl -s -X DELETE "${db_url}/${WRITE_TEST_PATH}.json" --max-time 5 >/dev/null 2>&1 || true
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

test_rtdb_authenticated() {
  local db_url="$1"
  local id_token="$2"
  local result_file="$3"

  db_url="${db_url%/}"
  if ! echo "$db_url" | grep -q '^https://'; then
    db_url="https://$db_url"
  fi

  log_info "Testing RTDB with auth token"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -H "User-Agent: $USER_AGENT" \
    "${db_url}/.json?auth=${id_token}" 2>/dev/null || echo '{}')

  if [ -n "$response" ] && [ "$response" != "null" ] && ! echo "$response" | grep -q "Permission denied"; then
    log_vuln "RTDB ACCESSIBLE WITH AUTH TOKEN"
    echo "VULNERABLE" >"$result_file"
    echo "$response" | head -c 500 >>"$result_file"
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

test_firestore_read() {
  local project_id="$1"
  local result_file="$2"

  log_info "Testing Firestore read: $project_id"

  local base_url="https://firestore.googleapis.com/v1/projects/${project_id}/databases/(default)/documents"
  local response

  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -H "User-Agent: $USER_AGENT" \
    "$base_url" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q '"documents"'; then
    log_vuln "FIRESTORE READ OPEN: $project_id"
    echo "VULNERABLE" >"$result_file"
    echo "$response" | head -c 500 >>"$result_file"
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

test_firestore_write() {
  local project_id="$1"
  local result_file="$2"

  log_info "Testing Firestore write: $project_id"

  local base_url="https://firestore.googleapis.com/v1/projects/${project_id}/databases/(default)/documents"
  local test_data='{"fields":{"security_test":{"stringValue":"firebase_scanner"}}}'

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$test_data" \
    "${base_url}/${WRITE_TEST_PATH}" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q "security_test"; then
    log_vuln "FIRESTORE WRITE OPEN: $project_id"
    echo "VULNERABLE" >"$result_file"

    local doc_name
    doc_name=$(echo "$response" | jq -r '.name // empty' 2>/dev/null || true)
    if [ -n "$doc_name" ]; then
      curl -s -X DELETE "https://firestore.googleapis.com/v1/${doc_name}" --max-time 5 >/dev/null 2>&1 || true
    fi
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

test_firestore_collections() {
  local project_id="$1"
  local result_file="$2"

  local common_collections="users user accounts account profiles profile members customers clients orders transactions payments messages chats conversations posts comments reviews products items settings config admin admins tokens sessions credentials logs events analytics notifications emails files documents images media uploads"

  log_info "Testing common Firestore collections..."

  local vulnerable_collections=""

  for collection in $common_collections; do
    local url="https://firestore.googleapis.com/v1/projects/${project_id}/databases/(default)/documents/${collection}"
    local response

    response=$(curl -s --max-time 5 "$url" 2>/dev/null || true)

    if echo "$response" | grep -q '"documents"'; then
      vulnerable_collections="$vulnerable_collections $collection"
      log_vuln "Firestore collection exposed: $collection"
    fi
  done

  if [ -n "$vulnerable_collections" ]; then
    echo "VULNERABLE" >"$result_file"
    echo "$vulnerable_collections" >>"$result_file"
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

#=============================================================================
# STORAGE TESTS
#=============================================================================

test_storage_bucket() {
  local bucket="$1"
  local result_file="$2"

  # Normalize bucket name
  bucket="${bucket%.appspot.com}"
  bucket="${bucket}.appspot.com"

  log_info "Testing Storage bucket: $bucket"

  local api_url="https://firebasestorage.googleapis.com/v0/b/${bucket}/o"
  local response

  response=$(curl -s --max-time "$TIMEOUT_SECONDS" "$api_url" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q '"items"'; then
    log_vuln "STORAGE BUCKET LISTABLE: $bucket"
    echo "VULNERABLE" >"$result_file"

    local file_count
    file_count=$(echo "$response" | jq '.items | length' 2>/dev/null || echo "unknown")
    echo "Files exposed: $file_count" >>"$result_file"
    echo "$response" | jq -r '.items[0:5][].name' 2>/dev/null >>"$result_file" || true
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

test_storage_bucket_write() {
  local bucket="$1"
  local result_file="$2"

  bucket="${bucket%.appspot.com}"
  bucket="${bucket}.appspot.com"

  log_info "Testing Storage bucket write: $bucket"

  local api_url="https://firebasestorage.googleapis.com/v0/b/${bucket}/o"
  local test_content="firebase_security_scanner_test"
  local test_path="${WRITE_TEST_PATH}.txt"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: text/plain" \
    --data-binary "$test_content" \
    "${api_url}?uploadType=media&name=${test_path}" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q '"name"'; then
    log_vuln "STORAGE BUCKET WRITABLE: $bucket"
    echo "VULNERABLE" >"$result_file"
    curl -s -X DELETE "${api_url}/${test_path}" --max-time 5 >/dev/null 2>&1 || true
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

#=============================================================================
# CLOUD FUNCTIONS TESTS
#=============================================================================

enumerate_cloud_functions() {
  local project_id="$1"
  local result_file="$2"
  local known_functions="$3"

  log_section "Enumerating Cloud Functions..."

  echo "ENUMERATION_RESULTS" >"$result_file"

  local found_functions=""
  local region="us-central1"

  # Combine known and common functions
  local all_functions="$known_functions $COMMON_FUNCTIONS"
  all_functions=$(echo "$all_functions" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')

  for func_name in $all_functions; do
    [ -z "$func_name" ] && continue

    local url="https://${region}-${project_id}.cloudfunctions.net/${func_name}"
    local http_code

    http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null || echo "000")

    if [ "$http_code" != "404" ] && [ "$http_code" != "000" ]; then
      found_functions="$found_functions ${func_name}:${http_code}"

      if [ "$http_code" = "200" ]; then
        log_vuln "Cloud Function found (200 OK): $func_name"
      elif [ "$http_code" = "403" ] || [ "$http_code" = "401" ]; then
        log_info "Cloud Function found (auth required): $func_name"
      else
        log_info "Cloud Function found (HTTP $http_code): $func_name"
      fi
    fi
  done

  if [ -n "$found_functions" ]; then
    echo "$found_functions" >>"$result_file"
    return 0
  fi

  return 1
}

test_callable_function() {
  local project_id="$1"
  local function_name="$2"
  local result_file="$3"

  log_info "Testing callable function: $function_name"

  local region="us-central1"
  local url="https://${region}-${project_id}.cloudfunctions.net/${function_name}"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"data":{}}' \
    "$url" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q '"result"'; then
    log_vuln "CALLABLE FUNCTION NO AUTH: $function_name"
    echo "VULNERABLE:NO_AUTH:$function_name" >>"$result_file"
    return 0
  elif echo "$response" | grep -qE "UNAUTHENTICATED|unauthenticated"; then
    log_success "Callable function requires auth: $function_name"
    echo "PROTECTED:$function_name" >>"$result_file"
  fi

  return 1
}

#=============================================================================
# REMOTE CONFIG TESTS
#=============================================================================

test_remote_config() {
  local project_id="$1"
  local api_key="$2"
  local result_file="$3"

  log_info "Testing Remote Config: $project_id"

  local url="https://firebaseremoteconfig.googleapis.com/v1/projects/${project_id}/remoteConfig"

  local response
  response=$(curl -s --max-time "$TIMEOUT_SECONDS" \
    -H "x-goog-api-key: $api_key" \
    "$url" 2>/dev/null || echo '{}')

  if echo "$response" | grep -q "parameters"; then
    log_vuln "REMOTE CONFIG EXPOSED: $project_id"
    echo "VULNERABLE" >"$result_file"
    echo "$response" | head -c 500 >>"$result_file"
    return 0
  fi

  echo "PROTECTED" >"$result_file"
  return 1
}

#=============================================================================
# MAIN PROCESSING
#=============================================================================

process_apk() {
  local apk_path="$1"
  local apk_name
  apk_name=$(basename "$apk_path" .apk)
  local apk_result_dir="${RESULTS_DIR}/${apk_name}"
  local apk_decompiled="${DECOMPILED_DIR}/${apk_name}"

  TOTAL_APKS=$((TOTAL_APKS + 1))

  echo ""
  echo "════════════════════════════════════════════════════════════"
  log_info "Processing: $apk_name"
  echo "════════════════════════════════════════════════════════════"

  mkdir -p "$apk_result_dir"

  # Decompile APK
  log_info "Decompiling APK..."
  if ! apktool d -f -o "$apk_decompiled" "$apk_path" >/dev/null 2>&1; then
    log_error "Failed to decompile: $apk_path"
    echo "DECOMPILE_FAILED" >"${apk_result_dir}/status.txt"
    return 1
  fi

  log_success "Decompilation complete"

  # Extract Firebase configuration (pass both decompiled dir and original APK path)
  log_info "Extracting Firebase configuration..."
  local config_file
  config_file=$(extract_firebase_config "$apk_decompiled" "$apk_path")

  if [ ! -f "$config_file" ]; then
    log_error "Failed to create config file"
    echo "CONFIG_FAILED" >"${apk_result_dir}/status.txt"
    return 1
  fi

  cp "$config_file" "$apk_result_dir/"

  # Read configuration into variables
  local db_urls
  local project_ids
  local storage_buckets
  local api_keys
  local function_names

  db_urls=$(jq -r '.database_urls[]?' "$config_file" 2>/dev/null | tr '\n' ' ' || true)
  project_ids=$(jq -r '.project_ids[]?' "$config_file" 2>/dev/null | tr '\n' ' ' || true)
  storage_buckets=$(jq -r '.storage_buckets[]?' "$config_file" 2>/dev/null | tr '\n' ' ' || true)
  api_keys=$(jq -r '.api_keys[]?' "$config_file" 2>/dev/null | tr '\n' ' ' || true)
  function_names=$(jq -r '.function_names[]?' "$config_file" 2>/dev/null | tr '\n' ' ' || true)

  local db_count proj_count bucket_count key_count func_count
  db_count=$(echo "$db_urls" | wc -w | tr -d ' ')
  proj_count=$(echo "$project_ids" | wc -w | tr -d ' ')
  bucket_count=$(echo "$storage_buckets" | wc -w | tr -d ' ')
  key_count=$(echo "$api_keys" | wc -w | tr -d ' ')
  func_count=$(echo "$function_names" | wc -w | tr -d ' ')

  log_success "Extraction complete:"
  log_info "  Database URLs: $db_count"
  log_info "  Project IDs: $proj_count"
  log_info "  Storage Buckets: $bucket_count"
  log_info "  API Keys: $key_count"
  log_info "  Function Names: $func_count"

  local apk_vulnerable=false
  local apk_vulns=""
  local anonymous_token=""

  #=========================================================================
  # AUTHENTICATION TESTS
  #=========================================================================
  local first_api_key
  first_api_key=$(echo "$api_keys" | awk '{print $1}')

  if [ -n "$first_api_key" ]; then
    log_section "Testing Firebase Authentication..."

    if test_auth_signup_enabled "$first_api_key" "${apk_result_dir}/auth_signup.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns AUTH_SIGNUP_OPEN"
    fi

    if test_auth_anonymous "$first_api_key" "${apk_result_dir}/auth_anonymous.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns AUTH_ANONYMOUS_ENABLED"
      anonymous_token=$(grep "ID_TOKEN:" "${apk_result_dir}/auth_anonymous.txt" 2>/dev/null | sed 's/ID_TOKEN://' || true)
    fi

    if test_auth_email_enumeration "$first_api_key" "${apk_result_dir}/auth_email_enum.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns AUTH_EMAIL_ENUMERATION"
    fi
  fi

  #=========================================================================
  # DATABASE TESTS
  #=========================================================================
  log_section "Testing Realtime Database..."

  for db_url in $db_urls; do
    [ -z "$db_url" ] && continue

    if test_rtdb_read "$db_url" "${apk_result_dir}/rtdb_read.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns RTDB_READ:$db_url"
    fi

    if test_rtdb_write "$db_url" "${apk_result_dir}/rtdb_write.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns RTDB_WRITE:$db_url"
    fi

    if [ -n "$anonymous_token" ]; then
      if test_rtdb_authenticated "$db_url" "$anonymous_token" "${apk_result_dir}/rtdb_auth.txt"; then
        apk_vulnerable=true
        apk_vulns="$apk_vulns RTDB_ANON_ACCESS:$db_url"
      fi
    fi
  done

  log_section "Testing Firestore..."

  for project_id in $project_ids; do
    [ -z "$project_id" ] && continue

    if test_firestore_read "$project_id" "${apk_result_dir}/firestore_read.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns FIRESTORE_READ:$project_id"
    fi

    if test_firestore_write "$project_id" "${apk_result_dir}/firestore_write.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns FIRESTORE_WRITE:$project_id"
    fi

    if test_firestore_collections "$project_id" "${apk_result_dir}/firestore_collections.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns FIRESTORE_COLLECTIONS:$project_id"
    fi
  done

  #=========================================================================
  # STORAGE TESTS
  #=========================================================================
  log_section "Testing Storage Buckets..."

  for bucket in $storage_buckets; do
    [ -z "$bucket" ] && continue

    if test_storage_bucket "$bucket" "${apk_result_dir}/storage_read.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns STORAGE_LISTABLE:$bucket"
    fi

    if test_storage_bucket_write "$bucket" "${apk_result_dir}/storage_write.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns STORAGE_WRITABLE:$bucket"
    fi
  done

  #=========================================================================
  # CLOUD FUNCTIONS TESTS
  #=========================================================================
  local first_project
  first_project=$(echo "$project_ids" | awk '{print $1}')

  if [ -n "$first_project" ]; then
    log_section "Testing Cloud Functions..."

    enumerate_cloud_functions "$first_project" "${apk_result_dir}/functions_enum.txt" "$function_names"

    for func_name in $function_names; do
      [ -z "$func_name" ] && continue

      if test_callable_function "$first_project" "$func_name" "${apk_result_dir}/functions_callable.txt"; then
        apk_vulnerable=true
        apk_vulns="$apk_vulns FUNCTION_NO_AUTH:$func_name"
      fi
    done
  fi

  #=========================================================================
  # REMOTE CONFIG TESTS
  #=========================================================================
  if [ -n "$first_project" ] && [ -n "$first_api_key" ]; then
    log_section "Testing Remote Config..."

    if test_remote_config "$first_project" "$first_api_key" "${apk_result_dir}/remote_config.txt"; then
      apk_vulnerable=true
      apk_vulns="$apk_vulns REMOTE_CONFIG_EXPOSED"
    fi
  fi

  #=========================================================================
  # SUMMARY
  #=========================================================================
  if [ "$apk_vulnerable" = true ]; then
    VULNERABLE_APKS=$((VULNERABLE_APKS + 1))
    echo "VULNERABLE" >"${apk_result_dir}/status.txt"
    echo "$apk_vulns" | tr ' ' '\n' | grep -v '^$' >"${apk_result_dir}/vulnerabilities.txt"
    local vuln_count
    vuln_count=$(echo "$apk_vulns" | wc -w | tr -d ' ')
    log_vuln "APK IS VULNERABLE: $apk_name ($vuln_count issues)"
  else
    echo "SECURE" >"${apk_result_dir}/status.txt"
    log_success "APK appears secure: $apk_name"
  fi
}

generate_report() {
  log_info "Generating final report..."

  {
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║        FIREBASE APK SECURITY SCAN REPORT v1.0             ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo ""
    echo "Scan Date: $(date)"
    echo "Total APKs Scanned: $TOTAL_APKS"
    echo "Vulnerable APKs: $VULNERABLE_APKS"
    echo "Total Vulnerabilities: $TOTAL_VULNS"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "EXTRACTION SOURCES"
    echo "═══════════════════════════════════════════════════════════"
    echo "• google-services.json"
    echo "• res/values/*.xml (strings.xml, values.xml, etc.)"
    echo "• AndroidManifest.xml"
    echo "• assets/ folder (hybrid apps: React Native, Flutter, Cordova)"
    echo "• res/raw/ resources"
    echo "• Smali/DEX code (const-string declarations)"
    echo "• Raw APK binary strings"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "VULNERABILITY CATEGORIES TESTED"
    echo "═══════════════════════════════════════════════════════════"
    echo "• Authentication: Open Signup, Anonymous Auth, Email Enumeration"
    echo "• Realtime Database: Unauthenticated Read/Write, Auth Bypass"
    echo "• Firestore: Document Access, Collection Enumeration"
    echo "• Storage: Bucket Listing (gs:// and appspot.com), Write Access"
    echo "• Cloud Functions: Unauthenticated Access, Function Enumeration"
    echo "• Remote Config: Public Exposure"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "DETAILED RESULTS"
    echo "═══════════════════════════════════════════════════════════"
    echo ""

    for result_dir in "$RESULTS_DIR"/*/; do
      [ -d "$result_dir" ] || continue
      local apk_name
      apk_name=$(basename "$result_dir")
      local status
      status=$(cat "${result_dir}/status.txt" 2>/dev/null || echo "UNKNOWN")

      echo "───────────────────────────────────────────────────────────"
      echo "APK: $apk_name"
      echo "Status: $status"

      if [ -f "${result_dir}/firebase_config.json" ]; then
        echo ""
        echo "Extracted Configuration:"
        jq '.' "${result_dir}/firebase_config.json" 2>/dev/null || true
      fi

      if [ -f "${result_dir}/vulnerabilities.txt" ]; then
        echo ""
        echo "Vulnerabilities Found:"
        while IFS= read -r vuln; do
          [ -n "$vuln" ] && echo "  • $vuln"
        done <"${result_dir}/vulnerabilities.txt"
      fi

      echo ""
    done

  } >"$REPORT_FILE"

  # Generate JSON report
  {
    echo '{'
    echo "  \"scan_date\": \"$(date)\","
    echo "  \"scanner_version\": \"1.0\","
    echo "  \"total_apks\": $TOTAL_APKS,"
    echo "  \"vulnerable_apks\": $VULNERABLE_APKS,"
    echo "  \"total_vulnerabilities\": $TOTAL_VULNS,"
    echo '  "results": ['

    local first=true
    for result_dir in "$RESULTS_DIR"/*/; do
      [ -d "$result_dir" ] || continue
      local apk_name
      apk_name=$(basename "$result_dir")
      local status
      status=$(cat "${result_dir}/status.txt" 2>/dev/null || echo "UNKNOWN")

      if [ "$first" = true ]; then
        first=false
      else
        echo ","
      fi

      echo "    {"
      echo "      \"apk\": \"$apk_name\","
      echo "      \"status\": \"$status\","

      if [ -f "${result_dir}/firebase_config.json" ]; then
        echo "      \"config\": $(cat "${result_dir}/firebase_config.json"),"
      fi

      echo "      \"vulnerabilities\": ["
      if [ -f "${result_dir}/vulnerabilities.txt" ]; then
        local vfirst=true
        while IFS= read -r vuln; do
          [ -z "$vuln" ] && continue
          if [ "$vfirst" = true ]; then
            vfirst=false
          else
            echo ","
          fi
          echo -n "        \"$vuln\""
        done <"${result_dir}/vulnerabilities.txt"
        echo ""
      fi
      echo "      ]"
      echo -n "    }"
    done

    echo ""
    echo "  ]"
    echo "}"
  } >"$JSON_REPORT"

  log_success "Reports generated:"
  log_success "  Text: $REPORT_FILE"
  log_success "  JSON: $JSON_REPORT"
}

main() {
  print_banner

  if [ $# -lt 1 ]; then
    echo "Usage: $0 <apk_directory|apk_file> [--no-cleanup]"
    echo ""
    echo "Examples:"
    echo "  $0 ./apks/              # Scan all APKs in directory"
    echo "  $0 ./myapp.apk          # Scan single APK"
    echo "  $0 ./apks/ --no-cleanup # Keep decompiled files"
    echo ""
    echo "Extraction sources:"
    echo "  • google-services.json"
    echo "  • res/values/*.xml files"
    echo "  • AndroidManifest.xml"
    echo "  • assets/ (React Native, Flutter, Cordova)"
    echo "  • res/raw/ resources"
    echo "  • Smali/DEX code"
    echo "  • Raw APK binary strings"
    echo ""
    echo "Tests performed:"
    echo "  • Firebase Auth: signup, anonymous auth, email enumeration"
    echo "  • Realtime Database: read, write, auth bypass"
    echo "  • Firestore: read, write, collection enumeration"
    echo "  • Storage: bucket listing (gs:// & appspot), write access"
    echo "  • Cloud Functions: enumeration, unauthenticated access"
    echo "  • Remote Config: public exposure"
    exit 1
  fi

  local target="$1"
  local cleanup=true
  if [ "${2:-}" = "--no-cleanup" ]; then
    cleanup=false
  fi

  check_dependencies
  setup_directories

  if [ -d "$target" ]; then
    log_info "Scanning directory: $target"
    for apk in "$target"/*.apk; do
      [ -f "$apk" ] || continue
      process_apk "$apk"
    done
  elif [ -f "$target" ]; then
    log_info "Scanning single APK: $target"
    process_apk "$target"
  else
    log_error "Target not found: $target"
    exit 1
  fi

  generate_report

  if [ "$cleanup" = true ]; then
    log_info "Cleaning up decompiled files..."
    rm -rf "$DECOMPILED_DIR"
  fi

  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "                    SCAN COMPLETE                           "
  echo "════════════════════════════════════════════════════════════"
  echo ""
  echo "Total APKs: $TOTAL_APKS"

  if [ $VULNERABLE_APKS -gt 0 ]; then
    printf 'Vulnerable: %s%d%s\n' "$RED" "$VULNERABLE_APKS" "$NC"
    printf 'Total Issues: %s%d%s\n' "$RED" "$TOTAL_VULNS" "$NC"
  else
    printf 'Vulnerable: %s0%s\n' "$GREEN" "$NC"
  fi

  echo ""
  echo "Results saved to: $OUTPUT_DIR"
}

main "$@"
