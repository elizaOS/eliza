Tako Client for Eliza

Tako is a decentralized social app. With Tako Client, you can integrate AI capabilities into Tako.

## Pre-Requisites

### Register a Tako Account

Sign up for a Tako account on the [Tako App](https://app.tako.so) and obtain your Tako ID.

Tako is developed in collaboration with Farcaster. Every Tako account must be linked to a Farcaster account.



- The identifier for a Tako account is the **Tako ID**.
- The identifier for a Farcaster account is the **FID**. For more details, refer to the [Farcaster Documentation](https://docs.farcaster.xyz/).

### Obtain a Tako API Key

Fill out and submit the application form: [Open the Form](https://docs.google.com/forms/d/e/1FAIpQLSfb0c4g3ZlexTVBfff3RCGqpv1wv7s3MweeXugPRwQqgbAGmA/viewform?usp=header).

After submitting the form, the review process will be completed within **48 hours**.

[API Documentation](https://takolab.notion.site/Tako-API-Docs-08f3c381f4ed4215a356cde1e0160979?pvs=4)

# Configurations

## .env

```
TAKO_FID=                       # FID, not the Tako ID
TAKO_API_KEY=                   # Tako API Key
TAKO_API_URL=                   # Tako API URL, currently only supports: https://open-api.tako.so
TAKO_PROACTIVE_COMMENTING=      # Boolean type; if set to true, the agent account will proactively interact with content from users specified in TAKO_TARGET_FOLLOWERS, TAKO_TARGET_USERS, and TAKO_TARGET_COMMUNITIES at regular intervals (currently only supports commenting)
TAKO_POLL_INTERVAL=             # Interval for proactive interactions with users, in minutes; default is 2 minutes.
TAKO_TARGET_FOLLOWERS=          # Boolean type; if set to true, the agent account will proactively interact with Farcaster accounts it follows (currently only supports commenting)
TAKO_TARGET_USERS=              # Specify a list of FIDs (not Tako IDs); the agent will proactively interact with them (currently only supports commenting), format: <fid1>,<fid2>,<fid3>
TAKO_TARGET_COMMUNITIES=        # Specify a list of community IDs; the agent will proactively interact with content posted in these communities (currently only supports commenting), format: <community id 1>,<community id 2>,<community id 3>
TAKO_BLACKLIST_USERS=           # Specify a list of FIDs (not Tako IDs); the agent account will not interact with these accounts, format: `<fid1>,<fid2>,<fid3>`
TAKO_CHAT_WITH_USER=            # Boolean type; if set to true, the agent account will continuously reply to user comments
TAKO_CHAT_INTERVAL=             # Interval for replying to user comments, in minutes; default is 2 minutes
TAKO_NEW_CAST=                  # Boolean type; if set to true, the agent account will periodically post new content
TAKO_NEW_CAST_INTERVAL=         # Interval for posting new content; default is 240 minutes
TAKO_START_DELAY=               # Boolean type; if set to true, when starting multiple agents using pnpm start --characters="1.character.json,2.character.json", each agent will have a random startup delay of 0-1 minutes to prevent excessive API requests
TAKO_DRY_RUN=false              # Boolean type; if set to true, the agent will generate tweets and comments but will not actually post them online
```

.env configuration can also be written in xx.character.json

## xx.character.json

```json
{
    ...

    "settings": {
        "secrets": {
            "OPENAI_API_KEY": ""
        },
        "TAKO_FID": 0,
        "TAKO_API_KEY": "",
        "TAKO_API_URL": "",
        "TAKO_PROACTIVE_COMMENTING": "true",
        "TAKO_POLL_INTERVAL": 60,
        "TAKO_TARGET_FOLLOWERS": "true",
        "TAKO_TARGET_USERS": "<fid1>,<fid2>,<fid3>",
        "TAKO_TARGET_COMMUNITIES": "tako,farcaster",
        "TAKO_BLACKLIST_USERS": "<fid1>,<fid2>,<fid3>",
        "TAKO_CHAT_WITH_USER": "true",
        "TAKO_CHAT_INTERVAL": 2,
        "TAKO_NEW_CAST": "true",
        "TAKO_NEW_CAST_INTERVAL": 360,
        "TAKO_START_DELAY": "true",
        "TAKO_DRY_RUN": "false"
    }

    ...
}
```