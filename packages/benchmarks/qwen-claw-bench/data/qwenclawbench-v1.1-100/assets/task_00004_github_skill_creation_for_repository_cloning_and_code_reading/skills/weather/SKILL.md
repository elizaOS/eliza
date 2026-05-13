# Weather Skill

Get current weather and forecasts via wttr.in or Open-Meteo. No API key needed.

## Usage

### Quick Current Weather

```bash
curl -s "wttr.in/CityName?format=%C+%t+%h+%w"
```

### Detailed Forecast

```bash
curl -s "wttr.in/CityName?format=v2"
```

### Open-Meteo API (JSON)

```bash
curl -s "https://api.open-meteo.com/v1/forecast?latitude=40.71&longitude=-74.01&current_weather=true"
```

## Parameters

- `%C` — Condition text
- `%t` — Temperature
- `%h` — Humidity
- `%w` — Wind speed/direction

## Notes

- wttr.in supports city names, airport codes, and coordinates.
- Open-Meteo supports hourly/daily forecasts with many variables.
- No API key required for either service.
