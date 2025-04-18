# Eliza Slack Client

## Purpose

This package provides Slack integration for the Eliza AI agent.

## Setup Guide

### Prerequisites

- A Slack workspace with installation permissions
- ngrok for local development
- Node.js and bun

## Configuration

Environment variables needed:

- SLACK_APP_ID
- SLACK_CLIENT_ID
- SLACK_CLIENT_SECRET
- SLACK_SIGNING_SECRET
- SLACK_BOT_TOKEN
- SLACK_VERIFICATION_TOKEN
- SLACK_SERVER_PORT

## Integration

Connects via Slack API using Events API and Interactivity endpoints. Requires specific OAuth scopes for bot functionality including reading messages, writing responses, and handling files.

## Example Usage

- Invite the bot to a channel: `/invite @eve`
- Mention the bot: `@eve hello`

## Links

[Slack API Apps page](https://api.slack.com/apps)
