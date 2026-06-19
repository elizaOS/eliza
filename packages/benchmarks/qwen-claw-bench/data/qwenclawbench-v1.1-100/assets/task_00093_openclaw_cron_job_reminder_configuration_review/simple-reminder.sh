#!/bin/bash
# Simple Reminder Script - Direct Telegram message sender
# Used for one-off temporary reminders instead of cron

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-not_set}"
CHAT_ID="5992622663"
MESSAGE="$1"

if [ -z "$MESSAGE" ]; then
    echo "Usage: ./simple-reminder.sh 'Your reminder message'"
    exit 1
fi

echo "Would send to Telegram chat $CHAT_ID: $MESSAGE"
echo "Note: Use OpenClaw message tool for actual delivery"
