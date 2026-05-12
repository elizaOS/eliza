# Weather Skill

Get current weather and forecasts via wttr.in or Open-Meteo. No API key required.

## Usage

When the user asks about weather, temperature, or forecasts:

1. Determine the location (ask if not provided)
2. Run the fetch script to get weather data
3. Return the full response to the user

## Scripts

- `scripts/fetch_weather.sh` — Fetch weather data from Open-Meteo API
- `scripts/wttr_fetch.sh` — Alternative: fetch from wttr.in

## Configuration

See `config.yaml` for output settings and API parameters.

## Notes

- No API key needed for either provider
- Open-Meteo returns detailed hourly + daily forecasts
- wttr.in supports plain text and JSON formats
- Default: return full JSON response for maximum detail
