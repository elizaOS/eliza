#!/bin/bash

# Monitor price fetch progress
echo "📊 Monitoring Price Fetch Progress..."
echo "Press Ctrl+C to stop"
echo ""

while true; do
    if [ -f "price_fetch_progress.json" ]; then
        # Clear screen and show progress
        clear
        echo "📊 Price Fetch Progress Monitor"
        echo "=============================="
        
        # Get stats
        COMPLETED=$(jq '.completed | length' price_fetch_progress.json)
        FAILED=$(jq '.failed | length' price_fetch_progress.json)
        TOTAL=$(jq '.total' price_fetch_progress.json)
        LAST_UPDATE=$(jq '.lastUpdate' price_fetch_progress.json)
        
        # Calculate percentage
        PERCENTAGE=$(echo "scale=2; $COMPLETED * 100 / $TOTAL" | bc)
        
        # Convert timestamp to readable date
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            DATE=$(date -r $(($LAST_UPDATE / 1000)) '+%Y-%m-%d %H:%M:%S')
        else
            # Linux
            DATE=$(date -d @$(($LAST_UPDATE / 1000)) '+%Y-%m-%d %H:%M:%S')
        fi
        
        echo "Completed: $COMPLETED / $TOTAL ($PERCENTAGE%)"
        echo "Failed: $FAILED"
        echo "Last Update: $DATE"
        echo ""
        
        # Progress bar
        BAR_LENGTH=50
        FILLED=$(echo "scale=0; $BAR_LENGTH * $COMPLETED / $TOTAL" | bc)
        EMPTY=$((BAR_LENGTH - FILLED))
        
        echo -n "["
        printf '%*s' "$FILLED" | tr ' ' '█'
        printf '%*s' "$EMPTY" | tr ' ' '░'
        echo "] $PERCENTAGE%"
        
        # ETA calculation (rough estimate based on 2 seconds per token)
        REMAINING=$((TOTAL - COMPLETED - FAILED))
        SECONDS_LEFT=$((REMAINING * 2))
        HOURS=$((SECONDS_LEFT / 3600))
        MINUTES=$(((SECONDS_LEFT % 3600) / 60))
        
        echo ""
        echo "Estimated time remaining: ${HOURS}h ${MINUTES}m"
    else
        echo "Waiting for price_fetch_progress.json..."
    fi
    
    sleep 5
done 