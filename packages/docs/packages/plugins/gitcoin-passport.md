# `@elizaos/plugin-passport`

This plugin provides actions for interacting with Gitcoin passport
https://docs.passport.xyz/building-with-passport/passport-api/overview

---

## Installation

Just add it under your character profile in plugins as

```
    "plugins": [
        "@elizaos/plugin-gitcoin-passport"
    ],
```

## Configuration

Getting Your API Key

1. Log in to the developer portal: Go to developer.passport.xyz and log in to your account by connecting your wallet.
2. Navigate to the API Keys section: After logging in, go to the "API Keys" section.
3. Generate an API key: Click on the "+ Create a Key" button to generate a unique API key for your account.
4. Store your API key securely: Store your API key in a secure place, as it will be used to access the Passport API.

Getting your Scorer ID

1. Log in to the Developer Portal: Go to developer.passport.xyz and log in to your account by connecting your wallet.
2. Navigate to the Scorer section: After logging in, go to the "Scorer" section
3. Create a Scorer: Click on the "+ Create a Scorer" button and input a Scorer name and description. Make sure you use the Unique Humanity scorer, and not the Binary scorer.
4. Find your Scorer ID: Click on the newly created Scorer and you will see the Scorer ID in the page URL.
   Example: https://developer.passport.xyz/dashboard/scorer/{scorer_id}

## Usage

Results are saved as message and agents can retrive it from there for different use cases.
Default passport treshold of 20 is used, but you can pick your own value and match it agains that
