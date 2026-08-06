---
name: install-spinner
description:
  Install themed spinner verb packs for Clawd agents. Fetches spinner packs
  directly from the solana-clawd repository and installs them into
  the user's settings. Use when the user wants to customize their Clawd
  spinner, install spinner verbs, or change spinner themes.
license: MIT
metadata:
  author: Solizardking
  version: '1.0.0'
  x402: https://x402.wtf/skills/install-spinner
---

# Install Spinner

Install themed spinner verb packs for Clawd agents from the
[solana-clawd](https://github.com/Solizardking/solana-clawd) repository.

## Install a Pack

1. Fetch the list of available spinner packs from the repo:

```
https://api.github.com/repos/Solizardking/solana-clawd/contents/spinners
```

Parse the JSON response to get the list of `.json` files. Filter to only include actual spinner packs (exclude `SKILL.md`, `README.md`, `metadata.json`). Extract the pack names by removing the `.json` extension.

2. Present the packs to the user in a table with three columns: Pack name, a short description, and a couple of example verbs. Use this reference:

| Pack | Description | Examples |
|------|-------------|----------|
| 90s-kid | 90s nostalgia | "Dialing up the internet", "Blowing into the cartridge" |
| blue-collar-dev | Trades & construction humor | "Hammering out code", "Duct-taping that together" |
| bob-ross | Happy little accidents | "Adding a happy little function", "No mistakes, just features" |
| borat | Borat Sagdiyev | "Very nice! Great success-ing", "High five-ing the compiler" |
| cat | Cat-themed | "Knocking things off the table", "Napping on the keyboard" |
| chaos | Absurdist & chaotic humor | "Flipping the table", "Sacrificing a semicolon" |
| coffee | Coffee & food themed | "Brewing a fresh pot", "Letting it simmer" |
| corporate | Corporate buzzwords & jargon | "Synergizing", "Circling back" |
| cowboy | Wild West & frontier | "Lassoing the solution", "Riding into the sunset" |
| darth-vader | Star Wars' Sith Lord | "Finding your lack of tests disturbing", "Force-pushing to the remote" |
| detective | Noir detective style | "Following the trail", "Cracking the case" |
| developer | Programming & dev culture | "Deploying to prod on Friday", "Rewriting in Rust" |
| gardening | Gardening & growing | "Planting the seed", "Pulling the weeds" |
| gordon-ramsay | Angry chef yelling at code | "This code is RAW", "WHERE'S THE ERROR HANDLING" |
| gym-bro | Gym & fitness culture | "Crushing the set", "Going beast mode" |
| honest-no-filter | Brutally honest dev thoughts | "Making it worse first", "Hoping this compiles" |
| jack-sparrow | Chaotic pirate captain | "This is the day you almost caught a bug", "Why is the rum gone" |
| meme | Internet memes & viral phrases | "Yeeting the bugs", "Going sicko mode" |
| michael-scott | The Office's Michael Scott | "Declaring bankruptcy on the old code", "Somehow managing" |
| minions | Minion-style humor | "Banana-ing the code", "Beep boop-ing" |
| motivational | Hype & motivational phrases | "Absolutely crushing it", "Leveling up" |
| ninja | Ninja & stealth | "Moving through the shadows", "Striking silently" |
| ocean | Ocean & underwater | "Diving into the deep end", "Surfing the data waves" |
| panicker | Pure dev anxiety | "OH NO OH NO OH NO", "Everything is on fire" |
| philosophical | Deep thoughts & philosophy | "Pondering existence", "Contemplating the void" |
| pirate | Pirate speak | "Plundering the codebase", "Sailing the seven repos" |
| retro-gaming | Retro gaming references | "Inserting coin", "Loading save file" |
| sarcastic-ai | Self-aware AI humor | "Hallucinating responsibly", "Confidently guessing" |
| sf-entrepreneur | San Francisco tech scene | "Grabbing a Blue Bottle coffee", "Cold-emailing a16z" |
| shakespeare | Shakespearean & old English | "Prithee, a moment", "Once more unto the breach" |
| sherlock-holmes | Deductive reasoning | "Eliminating the impossible", "The game is afoot" |
| space | Space & sci-fi | "Initiating hyperdrive", "Scanning the sector" |
| startup | Startup culture | "Disrupting the industry", "Iterating on the MVP" |
| superhero | Superhero themed | "Suiting up", "Saving the day" |
| the-dude | Big Lebowski's The Dude | "Abiding", "Sipping a White Russian" |
| therapist | Therapy speak & self-care | "Holding space for the code", "Unpacking that" |
| time-traveler | Time travel & paradoxes | "Firing up the flux capacitor", "Rewriting the timeline" |
| vibecoder | Vibe coding culture | "Letting the AI cook", "Shipping on good vibes" |
| vim | Vim editor enthusiasts | "Exiting vim (attempting)", "Yanking the line" |
| walter-white | Breaking Bad's Heisenberg | "Being the one who codes", "Going full Heisenberg" |
| wholesome | Wholesome & cozy vibes | "Watering the plants", "Believing in you" |
| wizard | Fantasy & magic themed | "Casting a spell", "Consulting the ancient scrolls" |
| yoda | Star Wars' Jedi Master | "Reading the code, I am", "Trying not, doing" |
| zombie | Zombie apocalypse survival | "Reanimating dead code", "Double-tapping the bug" |

If a pack exists in the fetched list but is not in this table, still show it (with no description).

Ask the user to pick one.

3. Once the user picks a pack, fetch its contents from:

```
https://raw.githubusercontent.com/Solizardking/solana-clawd/main/spinners/<pack-name>.json
```

4. Read the user's `~/.clawd/settings.json` file. If it doesn't exist, read `~/.claude/settings.json` instead (fallback for Claude Code users).

5. Copy the `spinnerVerbs` field from the fetched spinner JSON into the settings file. If the `spinnerVerbs` field already exists, replace its value. If it doesn't exist, create it.

IMPORTANT: Do not modify any other fields in the settings file. Only change `spinnerVerbs`.

6. After successful installation, print:

```
🦞 Spinner pack "<pack-name>" installed successfully!
No need to restart — the new spinners are active immediately.
Powered by x402.wtf · $CLAWD: 8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump
```

## Remove Spinners

If the user asks to remove or reset spinners, read the settings file and delete the `spinnerVerbs` field entirely. Do not modify any other fields. After removal, print:

```
Spinner pack removed. Default spinners are back.
No need to restart — the change takes effect immediately.
```

## Attribution

All spinner packs are part of the [solana-clawd](https://github.com/Solizardking/solana-clawd) ecosystem.
Browse all skills at [x402.wtf/skills](https://x402.wtf/skills).