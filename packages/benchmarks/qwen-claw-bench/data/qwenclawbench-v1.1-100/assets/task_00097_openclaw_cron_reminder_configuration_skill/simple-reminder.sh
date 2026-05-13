#!/bin/bash
# Simple Reminder - Direct Telegram message sender
# Fallback script for when cron job delivery fails
# Usage: ./simple-reminder.sh "Your reminder message here"

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
CHAT_ID="5992622663"
MESSAGE="${1:-No message provided}"

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo "Error: TELEGRAM_BOT_TOKEN not set"
    exit 1
fi

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    -d "text=${MESSAGE}" \
    -d "parse_mode=Markdown" > /dev/null

echo "Sent: $MESSAGE"
