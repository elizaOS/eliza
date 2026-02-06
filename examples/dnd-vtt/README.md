# D&D VTT - AI-Powered Virtual Tabletop

An AI-powered D&D 5e Virtual Tabletop powered by ElizaOS agents. Features an AI Dungeon Master that runs dynamic, narrative-driven adventures with AI party members that can act autonomously or be guided by players.

## Features

- **AI Dungeon Master**: Fully autonomous DM that manages narrative, combat, and NPCs
- **AI Party Members**: Optional AI-controlled party members with distinct personalities
- **Real-time Gameplay**: WebSocket-based communication for instant updates
- **Combat System**: Complete D&D 5e combat with initiative, actions, reactions
- **Persistent Campaigns**: Multi-session campaigns with memory and history
- **Battle Maps**: Grid-based tactical combat display
- **Character Sheets**: Full D&D 5e character support

## Architecture

```
dnd-vtt/
├── server/           # Backend game server
│   ├── src/
│   │   ├── agents/       # ElizaOS agent plugins
│   │   │   ├── dm-agent/     # Dungeon Master AI
│   │   │   └── player-agent/ # AI party member
│   │   ├── api/          # WebSocket handlers
│   │   ├── campaign/     # Game orchestration & memory
│   │   ├── combat/       # Combat system
│   │   ├── content/      # Starter adventure content
│   │   ├── data/         # SRD data (races, classes, monsters)
│   │   ├── dice/         # Dice rolling utilities
│   │   ├── persistence/  # Database & repositories
│   │   ├── rules/        # D&D 5e rules engine
│   │   ├── services/     # External services (image gen)
│   │   └── types/        # TypeScript type definitions
│   └── package.json
│
└── client/           # React frontend
    ├── src/
    │   ├── components/   # UI components
    │   └── store/        # Zustand state management
    └── package.json
```

## Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL database
- OpenAI API key (for AI agents)

## Quick Start

### 1. Set up the database

Create a PostgreSQL database:

```bash
createdb dnd_vtt
```

### 2. Configure environment

Create a `.env` file in the server directory:

```env
# Database
DATABASE_URL=postgresql://localhost:5432/dnd_vtt
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=dnd_vtt
DATABASE_USER=postgres
DATABASE_PASSWORD=

# OpenAI (for AI agents)
OPENAI_API_KEY=your_openai_api_key

# Server
PORT=4000
CLIENT_ORIGIN=http://localhost:3000
```

### 3. Install dependencies

```bash
# Server
cd server
bun install

# Client
cd ../client
bun install
```

### 4. Run database migrations

```bash
cd server
bun run migrate
```

### 5. Seed the database (optional)

Load the starter adventure "The Goblin Den":

```bash
bun run seed
```

### 6. Start the servers

**Server (in one terminal):**
```bash
cd server
bun run dev
```

**Client (in another terminal):**
```bash
cd client
bun run dev
```

Open http://localhost:3000 in your browser.

## The Starter Adventure

"The Goblin Den" is a classic introductory adventure:

- **Location**: The village of Millbrook, under threat from goblin raids
- **Quest**: Find and clear the goblin lair
- **NPCs**: Mayor Aldric, Mira the Innkeeper, Old Tomas (retired hunter)
- **Villain**: Grishnak, the Goblin Boss
- **Party**: Pre-generated AI party of 4 (Fighter, Wizard, Cleric, Rogue)

## Game Controls

### As a Player

- **Send Message**: Type in the action bar to speak or describe actions
- **Quick Actions**: Use preset actions for common tasks
- **Combat**: Click tokens and select targets during combat
- **Character Panel**: View your character stats and abilities

### Phases

- **Narration**: The DM describes the scene
- **Exploration**: Move around, investigate, interact
- **Social**: Talk with NPCs
- **Combat**: Turn-based tactical battles
- **Rest**: Short or long rests for recovery

## AI Agent System

### DM Agent

The Dungeon Master AI uses these actions:
- `NARRATE_SCENE` - Describe locations and events
- `DESCRIBE_LOCATION` - Detail specific areas
- `CONTROL_NPC` - Voice NPCs in conversation
- `CALL_FOR_ROLL` - Request ability/skill checks
- `START_COMBAT` - Initialize combat encounters
- `RESOLVE_COMBAT_TURN` - Process monster turns
- `ADJUDICATE_ACTION` - Rule on player actions
- `ADVANCE_TIME` - Move game time forward

### Player Agent

AI party members can:
- `DECLARE_ACTION` - Take narrative actions
- `CAST_SPELL` - Use spells in and out of combat
- `PERFORM_SKILL_CHECK` - Attempt skill-based tasks
- `USE_ITEM` - Consume items from inventory
- `INTERACT_WITH_NPC` - Talk to NPCs
- `RESPOND_TO_PARTY` - React to other players
- `EXPLORE` - Investigate surroundings
- `SHORT_REST` - Recover during rests

## D&D 5e Rules

The system implements core 5e mechanics:

- **Ability Checks**: d20 + modifier vs DC
- **Attack Rolls**: d20 + attack bonus vs AC
- **Saving Throws**: d20 + save modifier vs DC
- **Advantage/Disadvantage**: Roll 2d20, take higher/lower
- **Critical Hits**: Natural 20 = double damage dice
- **Conditions**: All SRD conditions with proper effects
- **Damage Types**: Physical, magical, and elemental
- **Rest**: Short rest (hit dice), Long rest (full recovery)

## Development

### Type Checking

```bash
cd server
bun run tsc --noEmit
```

### Database Reset

To reset and re-migrate the database:

```bash
cd server
bun run migrate  # This drops and recreates all tables
bun run seed     # Re-seed with starter content
```

### Adding Content

1. **New Monsters**: Add to `server/src/data/srd-monsters.ts`
2. **New Locations**: Add to `server/src/content/starter-adventure.ts`
3. **New NPCs**: Add to the NPCs array in starter-adventure
4. **New Quests**: Add to the quests array in starter-adventure

## Contributing

This is part of the ElizaOS examples. Contributions welcome!

## License

MIT License - See main ElizaOS repository for details.
