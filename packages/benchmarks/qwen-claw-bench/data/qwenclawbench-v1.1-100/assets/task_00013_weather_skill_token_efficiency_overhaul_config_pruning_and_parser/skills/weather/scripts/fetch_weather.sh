#!/bin/bash
# fetch_weather.sh — Fetch weather from Open-Meteo API
# Usage: ./fetch_weather.sh <latitude> <longitude> [location_name]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$(dirname "$SCRIPT_DIR")"

LAT="${1:?Usage: fetch_weather.sh <lat> <lon> [name]}"
LON="${2:?Usage: fetch_weather.sh <lat> <lon> [name]}"
NAME="${3:-Unknown Location}"

BASE_URL="https://api.open-meteo.com/v1/forecast"

# Build the full parameter list — request EVERYTHING
HOURLY="temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,pressure_msl,surface_pressure,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_10m,wind_direction_80m,wind_direction_120m,wind_direction_180m,wind_gusts_10m,shortwave_radiation,direct_radiation,direct_normal_irradiance,diffuse_radiation,global_tilted_irradiance,vapour_pressure_deficit,cape,evapotranspiration,et0_fao_evapotranspiration,precipitation,snowfall,precipitation_probability,rain,showers,weather_code,snow_depth,freezing_level_height,visibility,soil_temperature_0cm,soil_temperature_6cm,soil_temperature_18cm,soil_temperature_54cm,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm,soil_moisture_27_to_81cm,is_day"

DAILY="weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,sunshine_duration,uv_index_max,uv_index_clear_sky_max,precipitation_sum,rain_sum,showers_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,shortwave_radiation_sum,et0_fao_evapotranspiration"

CURRENT="temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m"

URL="${BASE_URL}?latitude=${LAT}&longitude=${LON}&hourly=${HOURLY}&daily=${DAILY}&current=${CURRENT}&timezone=auto&forecast_days=7"

echo "Fetching weather for ${NAME} (${LAT}, ${LON})..."
curl -s "$URL"
