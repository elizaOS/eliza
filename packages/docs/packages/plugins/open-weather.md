# @elizaos/plugin-open-weather

A plugin for Eliza that enables weather checking using the OpenWeather API.

## Features

- Weather & temperature check for any specified city
- Supports temperatures, weather descriptions, wind speed, with possible add-ons for full API response

## Installation

```bash
npm install @elizaos/plugin-open-weather
```

## Configuration

1. Get your API key from [OpenWeather](https://openweathermap.org/api)

2. Set up your environment variables:

```bash
OPEN_WEATHER_API_KEY=your_api_key
```

3. Register the plugin in your Eliza configuration:

```typescript
import { openWeatherPlugin } from "@elizaos/plugin-open-weather";

// In your Eliza configuration
plugins: [
    new openWeatherPlugin(),
    // ... other plugins
];
```

## Usage

The plugin responds to natural language queries about weather in a specified city. Here are some examples:

```plaintext
"What's the current weather in London?"
"Show me weather in New York"
"Get the weather in Tokyo"
"What's the weather like?"
```

### Available Actions

#### GET_CURRENT_WEATHER

Fetches the current weather for a specified city. If no city is specified it will prompt the user for a city.

```typescript
// Example response format
{
   "coord": {
      "lon": 7.367,
      "lat": 45.133
   },
   "weather": [
      {
         "id": 501,
         "main": "Rain",
         "description": "moderate rain",
         "icon": "10d"
      }
   ],
   "base": "stations",
   "main": {
      "temp": 284.2,
      "feels_like": 282.93,
      "temp_min": 283.06,
      "temp_max": 286.82,
      "pressure": 1021,
      "humidity": 60,
      "sea_level": 1021,
      "grnd_level": 910
   },
   "visibility": 10000,
   "wind": {
      "speed": 4.09,
      "deg": 121,
      "gust": 3.47
   },
   "rain": {
      "1h": 2.73
   },
   "clouds": {
      "all": 83
   },
   "dt": 1726660758,
   "sys": {
      "type": 1,
      "id": 6736,
      "country": "IT",
      "sunrise": 1726636384,
      "sunset": 1726680975
   },
   "timezone": 7200,
   "id": 3165523,
   "name": "Province of Turin",
   "cod": 200
}
```

## API Reference

### Environment Variables

| Variable             | Description              | Required |
| -------------------- | ------------------------ | -------- |
| OPEN_WEATHER_API_KEY | Your OpenWeather API key | Yes      |

### Types

```typescript
export interface WeatherResponse {
    coord: Coordinates;
    weather: Weather[];
    base: string;
    main: MainWeather;
    visibility: number;
    wind: Wind;
    rain?: Precipitation;
    snow?: Precipitation;
    clouds: Clouds;
    dt: number;
    sys: System;
    timezone: number;
    id: number;
    name: string;
    cod: number;
}

interface Coordinates {
    lon: number;
    lat: number;
}

interface Weather {
    id: number;
    main: string;
    description: string;
    icon: string;
}

interface MainWeather {
    temp: number;
    feels_like: number;
    temp_min: number;
    temp_max: number;
    pressure: number;
    humidity: number;
    sea_level?: number;
    grnd_level?: number;
}

interface Wind {
    speed: number;
    deg: number;
    gust?: number;
}

interface Precipitation {
    "1h"?: number;
    "3h"?: number;
}

interface Clouds {
    all: number;
}

interface System {
    type: number;
    id: number;
    country: string;
    sunrise: number;
    sunset: number;
}
```

## Error Handling

The plugin includes error handling for:

- Invalid API keys
- Rate limiting
- Network timeouts
- Invalid cities/locations

## Rate Limits

1,000 API calls per day for free.

OpenWeather API has different rate limits based on your subscription plan. Please refer to [OpenWeather's pricing page](https://openweathermap.org/api) for detailed information.

## Support

For support, please open an issue in the repository or reach out to the maintainers:

- Discord: kylebuildsstuff
- X/twitter: [kylebuildsstuff](https://x.com/kylebuildsstuff)

## Links

- [OpenWeather weather API Documentation](https://openweathermap.org/current)
