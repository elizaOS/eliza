# Sample API Integration Skill

Demonstrates how to call external APIs from within an OpenClaw skill.

## Overview

This skill template shows how to configure and call external REST APIs, including authentication, error handling, and response parsing.

## Configuration

External API credentials should be stored in `.env` or passed via the gateway config under `agent.providers`.

### Adding a new provider

1. Add the API key to `.env`:
   ```
   MY_API_KEY=sk-xxxxx
   MY_API_URL=https://api.example.com/v1
   ```

2. Reference it in your skill scripts.

## Scripts

- `scripts/call_api.sh` — Generic API caller with retry logic
- `scripts/test_connection.sh` — Verify API connectivity

## Notes

- Always validate API keys before making calls
- Respect rate limits (see provider docs)
- Log errors to `~/.openclaw/gateway.log`
