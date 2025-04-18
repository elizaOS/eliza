# `@elizaos/plugin-gitcoin-passport`

## Purpose

This plugin provides actions for interacting with Gitcoin passport.

## Installation

Add it under your character profile in plugins as:

```
    "plugins": [
        "@elizaos/plugin-gitcoin-passport"
    ],
```

## Configuration

1. Get API Key:

   - Log in at developer.passport.xyz with your wallet
   - Go to "API Keys" section
   - Click "+ Create a Key"
   - Store your API key securely

2. Get Scorer ID:
   - Go to "Scorer" section
   - Click "+ Create a Scorer" (use Unique Humanity scorer)
   - Find Scorer ID in page URL: https://developer.passport.xyz/dashboard/scorer/{scorer_id}

## Usage

Results are saved as messages and agents can retrieve them for different use cases. Default passport threshold of 20 is used, but custom values can be selected.

## Links

https://docs.passport.xyz/building-with-passport/passport-api/overview
