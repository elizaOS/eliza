# Weather Skill

Get current weather and forecasts via wttr.in or Open-Meteo. No API key needed.

## When to Use

- User asks about weather, temperature, or forecasts for any location
- Checking conditions before outdoor activities

## Usage

```bash
curl -s "wttr.in/Shanghai?format=j1" | jq '.current_condition[0]'
```

## Supported Queries

- Current conditions: temperature, humidity, wind, visibility
- 3-day forecast: high/low temps, precipitation chance
- Location: city name, coordinates, or airport code
