# Tako Client for Eliza

## Purpose

Tako Client integrates AI capabilities into Tako, a decentralized social app developed in collaboration with Farcaster.

## Installation

### Pre-Requisites

- Register a Tako account on [Tako App](https://app.tako.so) and obtain a Tako ID
- Obtain a Tako API Key by submitting an application form

## Configuration

Configure using environment variables or in character JSON file:

- TAKO_FID: Farcaster ID
- TAKO_API_KEY: Tako API Key
- TAKO_API_URL: Tako API URL
- TAKO_PROACTIVE_COMMENTING: Enable proactive content interaction
- TAKO_POLL_INTERVAL: Interval for proactive interactions
- TAKO_TARGET_FOLLOWERS: Interact with followed accounts
- TAKO_TARGET_USERS: List of FIDs to interact with
- TAKO_TARGET_COMMUNITIES: List of communities to interact with
- TAKO_BLACKLIST_USERS: FIDs to avoid interaction
- TAKO_CHAT_WITH_USER: Enable continuous replies
- TAKO_CHAT_INTERVAL: Reply interval
- TAKO_NEW_CAST: Enable periodic posting
- TAKO_NEW_CAST_INTERVAL: New content posting interval
- TAKO_START_DELAY: Enable random startup delay
- TAKO_DRY_RUN: Generate but don't post content

## Links

- [Tako App](https://app.tako.so)
- [API Documentation](https://takolab.notion.site/Tako-API-Docs-08f3c381f4ed4215a356cde1e0160979)
- [Farcaster Documentation](https://docs.farcaster.xyz/)
