# @elizaos/plugin-open-weather

## Purpose

A plugin for Eliza that enables weather checking using the OpenWeather API.

## Key Features

- Weather & temperature check for any specified city
- Supports temperatures, weather descriptions, wind speed, with possible add-ons for full API response

## Installation

```bash
bun install @elizaos/plugin-open-weather
```

## Configuration

1. Get your API key from OpenWeather
2. Set up environment variable: OPEN_WEATHER_API_KEY=your_api_key
3. Register the plugin in Eliza configuration:

```typescript
import { openWeatherPlugin } from '@elizaos/plugin-open-weather';

// In your Eliza configuration
plugins: [
  new openWeatherPlugin(),
  // ... other plugins
];
```

## Integration

The plugin responds to natural language queries about weather in specified cities and provides the GET_CURRENT_WEATHER action.

## Example Usage

```plaintext
"What's the current weather in London?"
"Show me weather in New York"
"Get the weather in Tokyo"
"What's the weather like?"
```

## Links

- [OpenWeather weather API Documentation](https://openweathermap.org/current)
