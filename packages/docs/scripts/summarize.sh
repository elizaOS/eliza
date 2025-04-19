#!/usr/bin/env bash

# Script to summarize a text/json/mp3 file using AI via OpenRouter API
# Usage: ./summarize.sh -i <input_file> [-p <prompt_text_or_file>] [-m <model>] [-o <output_file>] [-k <api_key>]

set -e

# Default values
MODEL="anthropic/claude-3.7-sonnet"
DEFAULT_PROMPT="Please summarize the following transcript. Include key points and important timestamps when specific topics were discussed. Structure the summary to highlight the most important information."
API_KEY=${OPENROUTER_API_KEY:-""}
OUTPUT_FILE=""

# Function to display usage info
usage() {
  echo "Usage: $0 -i <input_file> [-p <prompt_text_or_file>] [-m <model>] [-o <output_file>] [-k <api_key>]"
  echo
  echo "Options:"
  echo "  -i  Input file to summarize (required): text, markdown, json, or mp3"
  echo "  -p  Custom prompt text or file containing prompt (optional)"
  echo "  -m  OpenRouter model to use (default: anthropic/claude-3.7-sonnet)"
  echo "  -o  Output file for the summary (default: input_filename.md)"
  echo "  -k  OpenRouter API key (optional, can also use OPENROUTER_API_KEY env var)"
  echo "  -h  Display this help message"
  exit 1
}

# Check if a string is a file path or direct text
is_file() {
  [ -f "$1" ]
}

# Parse command-line arguments
while getopts "i:p:m:o:k:h" opt; do
  case ${opt} in
    i )
      INPUT_FILE=$OPTARG
      ;;
    p )
      PROMPT_INPUT=$OPTARG
      ;;
    m )
      MODEL=$OPTARG
      ;;
    o )
      OUTPUT_FILE=$OPTARG
      ;;
    k )
      API_KEY=$OPTARG
      ;;
    h )
      usage
      ;;
    \? )
      usage
      ;;
  esac
done

# Check if input file was provided
if [ -z "$INPUT_FILE" ]; then
  echo "Error: Input file is required"
  usage
fi

# Check if input file exists
if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: File '$INPUT_FILE' not found"
  exit 1
fi

# Check if API key is available
if [ -z "$API_KEY" ]; then
  echo "Error: OpenRouter API key is required"
  echo "Either set the OPENROUTER_API_KEY environment variable or use the -k option"
  exit 1
fi

# Check for required tools
for cmd in curl jq; do
  if ! command -v $cmd &> /dev/null; then
    echo "Error: $cmd is required but not installed"
    exit 1
  fi
done

# Determine file type and process accordingly
FILE_EXT="${INPUT_FILE##*.}"
CONTENT=""

if [ "$FILE_EXT" = "mp3" ]; then
  # Check if insanely-fast-whisper is installed
  if ! command -v insanely-fast-whisper &> /dev/null; then
    echo "Error: Processing MP3 files requires insanely-fast-whisper but it's not installed"
    echo "Please install via: pipx install insanely-fast-whisper --force --pip-args=\"--ignore-requires-python\""
    echo "or: pip install insanely-fast-whisper --ignore-requires-python"
    exit 1
  fi
  
  # Process MP3 file with insanely-fast-whisper and save output to temporary JSON file
  TMP_JSON="/tmp/whisper_output_$(date +%s).json"
  echo "Transcribing MP3 file with insanely-fast-whisper..."
  
  # Detect if running on macOS
  if [[ "$(uname)" == "Darwin" ]]; then
    DEVICE_FLAG="--device-id mps"
  else
    DEVICE_FLAG=""
  fi
  
  # Run insanely-fast-whisper
  insanely-fast-whisper --file-name "$INPUT_FILE" $DEVICE_FLAG --transcript-path "$TMP_JSON"
  
  # Check if JSON was created successfully
  if [ ! -f "$TMP_JSON" ]; then
    echo "Error: Failed to create transcript JSON"
    exit 1
  fi
  
  echo "Transcription complete. JSON saved to $TMP_JSON"
  
  # Use the JSON for summarization
  INPUT_FILE="$TMP_JSON"
  FILE_EXT="json"
fi

if [ "$FILE_EXT" = "json" ]; then
  # Check if it looks like a whisper JSON output with "chunks" format
  if jq -e '.chunks' "$INPUT_FILE" &> /dev/null; then
    echo "Detected whisper JSON with chunks format"
    
    # Extract the timestamped chunks in a useful format for summarization
    FORMATTED_CONTENT=$(jq -r '.chunks[] | "[" + (.timestamp[0] | tostring) + "-" + (.timestamp[1] | tostring) + "]: " + .text' "$INPUT_FILE")
    CONTENT="$FORMATTED_CONTENT"
  # Check if it has the speakers format
  elif jq -e '.speakers' "$INPUT_FILE" &> /dev/null; then
    echo "Detected whisper JSON with speakers format"
    
    # Format the JSON with speakers and timestamps
    FORMATTED_CONTENT=$(jq -r 'if .speakers | length > 0 then .speakers[] | .speaker + " [" + (.start | tostring) + "-" + (.end | tostring) + "]: " + .text else .chunks[] | "[" + (.timestamp[0] | tostring) + "-" + (.timestamp[1] | tostring) + "]: " + .text end' "$INPUT_FILE")
    CONTENT="$FORMATTED_CONTENT"
  # Fall back to just getting .text if it exists
  elif jq -e '.text' "$INPUT_FILE" &> /dev/null; then
    echo "Detected whisper JSON with text field only"
    CONTENT=$(jq -r '.text' "$INPUT_FILE")
  else
    # Normal JSON, just use as is
    echo "Processing as regular JSON"
    CONTENT=$(cat "$INPUT_FILE")
  fi
else
  # Regular text file
  echo "Processing as plain text file"
  CONTENT=$(cat "$INPUT_FILE")
fi

# Determine the prompt to use
if [ -n "$PROMPT_INPUT" ]; then
  if is_file "$PROMPT_INPUT"; then
    # Use custom prompt from file
    PROMPT=$(cat "$PROMPT_INPUT")
  else
    # Use custom prompt from command line
    PROMPT="$PROMPT_INPUT"
  fi
else
  # Use default prompt
  PROMPT=$DEFAULT_PROMPT
fi

# Construct the final prompt
FINAL_PROMPT="$PROMPT\n\nTranscript with timestamps:\n$CONTENT"

# Make API request to OpenRouter
echo "Sending request to $MODEL via OpenRouter..."
RESPONSE=$(curl -s "https://openrouter.ai/api/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "HTTP-Referer: https://github.com/yourusername/text-summarizer" \
  -H "X-Title: Text Summarizer Script" \
  -d @- << EOF
{
  "model": "$MODEL",
  "messages": [
    {
      "role": "user",
      "content": $(printf '%s\n' "$FINAL_PROMPT" | jq -Rs .)
    }
  ]
}
EOF
)

# Extract the response content using jq
SUMMARY=$(echo "$RESPONSE" | jq -r '.choices[0].message.content')

# Check if we got a valid response
if [ -z "$SUMMARY" ] || [ "$SUMMARY" == "null" ]; then
  echo "Error: Failed to get a valid response"
  echo "API Response: $RESPONSE"
  exit 1
fi

# Print the summary
echo -e "\n===== SUMMARY =====\n"
echo "$SUMMARY"
echo -e "\n==================="

# Determine output file path
if [ -z "$OUTPUT_FILE" ]; then
  # Default output file name if none specified
  OUTPUT_FILE="${INPUT_FILE%.*}.md"
fi

# Save the summary to file
echo "$SUMMARY" > "$OUTPUT_FILE"
echo -e "\nSummary saved to: $OUTPUT_FILE"
