# Virtual Power Plant API Endpoints (v1.0 Draft)

> **Status:** DRAFT — For future real-time version. Not implemented in v0.1.
> **Last Updated:** 2024-06-10
> **Author:** Platform Engineering Team

---

## Overview

This document describes the REST API and WebSocket endpoints planned for the **v1.0 real-time** version of the Virtual Power Plant Dashboard. These endpoints will replace the static CSV/JSON data files used in the current v0.1 prototype.

## Base URL

```
Production: https://api.greenfield-vpp.com/v1
Staging:    https://api-staging.greenfield-vpp.com/v1
```

## Authentication

All endpoints require a valid Bearer token in the `Authorization` header:

```
Authorization: Bearer <your-api-key>
```

API keys can be generated from the VPP Admin Portal. Keys expire after 90 days.

### Rate Limits

| Tier       | Requests/min | WebSocket connections |
|------------|-------------|----------------------|
| Free       | 60          | 1                    |
| Standard   | 300         | 5                    |
| Enterprise | 3000        | 50                   |

---

## REST Endpoints

### GET /api/realtime/generation

Returns the current power generation data from all sources.

**Response (200 OK):**
```json
{
  "timestamp": "2024-06-15T14:30:00Z",
  "solar_kw": 742.3,
  "wind_kw": 185.6,
  "total_kw": 927.9,
  "solar_irradiance_w_m2": 890,
  "wind_speed_m_s": 6.2
}
```

**Query Parameters:**
- `from` (ISO 8601) — Start of time range
- `to` (ISO 8601) — End of time range
- `resolution` — `1m`, `5m`, `15m`, `1h` (default: `1m`)

---

### GET /api/realtime/consumption

Returns the current power consumption data by sector.

**Response (200 OK):**
```json
{
  "timestamp": "2024-06-15T14:30:00Z",
  "residential_kw": 312.5,
  "commercial_kw": 389.1,
  "industrial_kw": 367.8,
  "total_consumption_kw": 1069.4
}
```

**Query Parameters:**
- `from`, `to`, `resolution` — Same as generation endpoint

---

### GET /api/realtime/battery

Returns the current battery storage status.

**Response (200 OK):**
```json
{
  "timestamp": "2024-06-15T14:30:00Z",
  "soc_percent": 72.3,
  "charge_rate_kw": 150.0,
  "discharge_rate_kw": 0.0,
  "temperature_celsius": 28.4,
  "health_percent": 98.2
}
```

---

### POST /api/control/battery

Sends a charge/discharge command to the battery management system.

**Request Body:**
```json
{
  "action": "charge",
  "rate_kw": 100,
  "duration_minutes": 30,
  "priority": "normal"
}
```

**Response (202 Accepted):**
```json
{
  "command_id": "cmd-a1b2c3d4",
  "status": "queued",
  "estimated_execution": "2024-06-15T14:31:00Z"
}
```

**Allowed actions:** `charge`, `discharge`, `idle`

> ⚠️ **Note:** This endpoint requires `operator` role permissions.

---

### GET /api/grid/pricing

Returns current and forecasted grid electricity prices.

**Response (200 OK):**
```json
{
  "current": {
    "buy_price_per_kwh": 0.18,
    "sell_price_per_kwh": 0.09,
    "tariff_period": "mid-peak"
  },
  "forecast_24h": [
    {"hour": 15, "buy": 0.19, "sell": 0.095},
    {"hour": 16, "buy": 0.22, "sell": 0.11}
  ]
}
```

---

## WebSocket Endpoint

### WS /ws/live-data

Provides real-time streaming data for the dashboard.

**Connection:**
```
wss://api.greenfield-vpp.com/v1/ws/live-data?token=<api-key>
```

**Message Format:**
```json
{
  "type": "generation_update",
  "timestamp": "2024-06-15T14:30:05Z",
  "data": {
    "solar_kw": 743.1,
    "wind_kw": 184.9,
    "total_kw": 928.0
  }
}
```

**Subscription Topics:**
- `generation` — Solar and wind generation updates (1s interval)
- `consumption` — Consumption by sector (5s interval)
- `battery` — Battery SOC and rates (10s interval)
- `pricing` — Grid pricing updates (60s interval)

**Subscribe message:**
```json
{
  "action": "subscribe",
  "topics": ["generation", "battery"]
}
```

---

## Error Codes

| Code | Description                    |
|------|--------------------------------|
| 401  | Invalid or expired API key     |
| 403  | Insufficient permissions       |
| 404  | Resource not found             |
| 429  | Rate limit exceeded            |
| 500  | Internal server error          |
| 503  | Service temporarily unavailable|

---

## Changelog

- **2024-06-10:** Initial draft created
- **TBD:** v1.0 release target Q3 2024
