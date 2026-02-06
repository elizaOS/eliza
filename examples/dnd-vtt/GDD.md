# AI D&D Virtual Tabletop - Game Design Document

## Executive Summary

**Project Name**: Eliza Dungeons - AI-Powered D&D 5e Virtual Tabletop  
**Platform**: Web-based (Custom React VTT + Socket.io)  
**AI Framework**: ElizaOS  
**Target Experience**: A fully playable D&D 5e campaign with an AI Dungeon Master and fully autonomous AI agent party members, supporting multi-session campaigns with persistent world history

---

## Table of Contents

1. [Project Goals](#1-project-goals)
2. [System Architecture](#2-system-architecture)
3. [Game Mechanics](#3-game-mechanics)
4. [AI Agent Design](#4-ai-agent-design)
5. [VTT Design](#5-vtt-design)
6. [Data Models](#6-data-models)
7. [Turn & Round System](#7-turn--round-system)
8. [Campaign Persistence](#8-campaign-persistence)
9. [Image Generation](#9-image-generation)
10. [Technical Implementation](#10-technical-implementation)
11. [Risks & Unknowns](#11-risks--unknowns)
12. [Development Roadmap](#12-development-roadmap)

---

## 1. Project Goals

### 1.1 Primary Objectives

1. **AI Dungeon Master**: Create an Eliza agent that runs D&D 5e campaigns, managing narrative, NPCs, monsters, combat, and world state
2. **Fully Autonomous AI Players**: Eliza agents that roleplay characters independently, making all decisions like real players at a table
3. **Mixed Party Play**: Support parties of 4-6 with any combination of human players and AI agent characters
4. **Custom VTT**: Purpose-built virtual tabletop with battle maps, tokens, dice, and D&D-specific UI
5. **Campaign Persistence**: Multi-session campaigns with world history, character progression, and narrative continuity
6. **D&D 5e SRD Compliance**: Implement core D&D 5e mechanics from the SRD
7. **Dynamic Image Generation**: Generate images for monsters, characters, locations, and items on-demand

### 1.2 Player Experience Goals

- **Human Players**: Join via browser, see the VTT, control their characters, interact with AI DM and AI party members
- **AI Players**: Fully autonomous agents that roleplay, make tactical decisions, have personality, and remember past sessions
- **Spectators**: Watch games in progress (AI-only parties can run as entertainment)

### 1.3 Non-Goals (Out of Scope)

- Full D&D 5e rules (SRD content only - no homebrew hooks)
- Voice/video integration (text only)
- Character leveling beyond 5th level
- Mobile-optimized UI (desktop-first)

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        ELIZA DUNGEONS SYSTEM                              │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐    ┌─────────────────────┐    ┌─────────────────────┐  │
│  │   Human     │    │   AI Player Agents  │    │  AI Dungeon Master  │  │
│  │   Players   │    │   (1-6 per party)   │    │       Agent         │  │
│  │  (Browser)  │    │     (ElizaOS)       │    │     (ElizaOS)       │  │
│  └──────┬──────┘    └─────────┬───────────┘    └──────────┬──────────┘  │
│         │                     │                           │             │
│         ▼                     ▼                           ▼             │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                       GAME COORDINATOR                              │ │
│  │  - Turn Management    - State Sync    - Rules Engine               │ │
│  │  - Campaign History   - Session Save/Load                          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│         │                     │                           │             │
│         ▼                     ▼                           ▼             │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────────┐ │
│  │  Custom VTT  │  │   D&D 5e Rules   │  │   Image Generation        │ │
│  │   (React +   │  │     Engine       │  │   (OpenAI/Fal/Groq)       │ │
│  │  Socket.io)  │  │                  │  │                           │ │
│  └──────────────┘  └──────────────────┘  └───────────────────────────┘ │
│         │                                                               │
│         ▼                                                               │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                      PERSISTENCE LAYER                              │ │
│  │  PostgreSQL: Campaigns, Characters, World State, Session History   │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Breakdown

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| DM Agent | ElizaOS Runtime | Narrative, NPCs, world state, encounter design, remembers campaign history |
| Player Agents | ElizaOS Runtime (1 per AI PC) | Fully autonomous roleplay, tactical decisions, character memory |
| Game Coordinator | TypeScript Service | Turn order, state sync, rules validation, session management |
| Custom VTT | React + Socket.io + Canvas | Battle maps, tokens, dice, initiative tracker, character sheets |
| Rules Engine | TypeScript | Combat math, spell effects, ability checks, condition tracking |
| Campaign DB | PostgreSQL | World state, character progression, session history, NPC relationships |
| Image Gen | OpenAI/Fal/Groq API | Monster art, character portraits, location scenes |

### 2.3 Communication Flow

```
Human Input → VTT → WebSocket → Game Coordinator → DM Agent → Response
                                        ↓
                              Rules Engine (validate)
                                        ↓
                              State Update → VTT Broadcast
                                        ↓
                              Campaign DB (persist)

AI Player Turn:
Game Coordinator → Player Agent → Decision → Game Coordinator → Rules → State Update
                        ↑
                 Character Memory + Campaign Context
```

### 2.4 Multi-Agent Communication

```
┌────────────────────────────────────────────────────────────────┐
│                    AGENT MESSAGE BUS                            │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   DM Agent ◄──────────────────────────────────────────────►    │
│       │                                                        │
│       │    ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│       └───►│ Player 1 │  │ Player 2 │  │ Player 3 │ ...       │
│            │  Agent   │  │  Agent   │  │  Agent   │           │
│            └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│                 │             │             │                  │
│                 └─────────────┴─────────────┘                  │
│                         Party Chat                             │
│                    (in-character comms)                        │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Game Mechanics

### 3.1 D&D 5e Core Mechanics (SRD)

#### 3.1.1 Ability Scores
- **Strength** (STR): Physical power, melee attacks
- **Dexterity** (DEX): Agility, ranged attacks, AC, initiative
- **Constitution** (CON): Health, stamina, concentration
- **Intelligence** (INT): Knowledge, arcane magic
- **Wisdom** (WIS): Perception, divine magic
- **Charisma** (CHA): Social skills, sorcerer/warlock magic

#### 3.1.2 Core Resolution Mechanic
```
d20 + Ability Modifier + Proficiency Bonus (if applicable) vs DC/AC
```

#### 3.1.3 Combat Actions (Per Turn)
| Action Type | Examples |
|-------------|----------|
| **Action** | Attack, Cast Spell, Dash, Disengage, Dodge, Help, Hide, Ready, Search, Use Object |
| **Bonus Action** | Off-hand attack, certain spells, class features |
| **Movement** | Up to speed (typically 30 ft) |
| **Reaction** | Opportunity attack, certain spells (Shield, Counterspell) |
| **Free Action** | Drop item, speak briefly |

#### 3.1.4 Combat Flow
1. **Surprise** (if applicable)
2. **Roll Initiative** (d20 + DEX modifier)
3. **Take Turns** (in initiative order)
4. **Repeat** until combat ends

### 3.2 Supported SRD Classes (v1)

| Class | Primary Ability | Role | Key Feature |
|-------|-----------------|------|-------------|
| Fighter | STR/DEX | Martial | Extra Attack, Action Surge |
| Rogue | DEX | Striker | Sneak Attack, Cunning Action |
| Wizard | INT | Arcane Caster | Spellbook, Arcane Recovery |
| Cleric | WIS | Divine Caster | Channel Divinity, Healing |

### 3.3 Exploration Mechanics

| Activity | Resolution |
|----------|------------|
| **Perception** | WIS (Perception) check vs DC |
| **Investigation** | INT (Investigation) check vs DC |
| **Stealth** | DEX (Stealth) vs Passive Perception |
| **Persuasion** | CHA (Persuasion) vs DC |
| **Intimidation** | CHA (Intimidation) vs DC |
| **Athletics** | STR (Athletics) vs DC |

### 3.4 Rest Mechanics

| Rest Type | Duration | Benefits |
|-----------|----------|----------|
| **Short Rest** | 1 hour | Spend Hit Dice to heal, recover some abilities |
| **Long Rest** | 8 hours | Full HP, recover all Hit Dice, recover spell slots |

---

## 4. AI Agent Design

### 4.1 Dungeon Master Agent

#### 4.1.1 Character Definition
```typescript
const dungeonMasterCharacter = {
  name: "Dungeon Master",
  bio: [
    "An experienced D&D game master who creates immersive, balanced encounters",
    "Fair but challenging, focused on player enjoyment",
    "Expert in D&D 5e rules and lore",
  ],
  system: `You are the Dungeon Master for a D&D 5e campaign.

RESPONSIBILITIES:
1. Narrate scenes vividly but concisely
2. Control all NPCs and monsters
3. Adjudicate rules fairly using D&D 5e SRD
4. Create engaging encounters and story hooks
5. Track initiative, HP, conditions, and game state
6. Request dice rolls when appropriate
7. Describe combat results dramatically

RULES:
- Always use D&D 5e mechanics for resolution
- Be fair but create tension and challenge
- Give players meaningful choices
- Pace the game to maintain engagement
- Generate image prompts for key moments`,
  adjectives: ["fair", "creative", "dramatic", "knowledgeable"],
};
```

#### 4.1.2 DM Plugin Actions

| Action | Description | Parameters |
|--------|-------------|------------|
| `DESCRIBE_SCENE` | Narrate current location/situation | `scene`, `mood`, `npcs` |
| `REQUEST_ROLL` | Ask for ability check/save/attack | `type`, `ability`, `dc`, `target` |
| `RESOLVE_ATTACK` | Calculate attack result | `attacker`, `target`, `roll`, `modifiers` |
| `APPLY_DAMAGE` | Deal damage to entity | `target`, `amount`, `type` |
| `CONTROL_NPC` | Have NPC take action | `npc`, `action`, `target` |
| `START_COMBAT` | Initialize combat encounter | `enemies`, `positions` |
| `ADVANCE_TURN` | Move to next combatant | - |
| `END_COMBAT` | Resolve combat conclusion | `outcome` |
| `GENERATE_IMAGE` | Create visual for scene/entity | `prompt`, `type` |
| `UPDATE_MAP` | Modify VTT board state | `changes` |

#### 4.1.3 DM Providers

| Provider | Data Supplied |
|----------|---------------|
| `game_state` | Current phase, turn order, round number |
| `party_status` | All PC stats, HP, conditions, positions |
| `encounter_state` | Active enemies, their HP, conditions |
| `location_context` | Current map, environment, lighting |
| `campaign_memory` | Previous events, NPC relationships |

### 4.2 Player Character Agents

#### 4.2.1 Character Definition Template
```typescript
const createPlayerAgent = (character: CharacterSheet) => ({
  name: character.name,
  bio: [
    `A ${character.race} ${character.class} adventurer`,
    character.background,
    character.personality,
  ],
  system: `You are ${character.name}, a player character in a D&D 5e campaign.

CHARACTER SHEET:
${formatCharacterSheet(character)}

ROLEPLAY GUIDELINES:
1. Stay in character at all times
2. Make decisions based on your personality and motivations
3. Work with the party but pursue your character goals
4. Describe your actions dramatically
5. Use your abilities strategically in combat

COMBAT BEHAVIOR:
- Prioritize survival but take calculated risks
- Use class abilities effectively
- Coordinate with party members
- Consider positioning and tactics`,
  adjectives: character.traits,
});
```

#### 4.2.2 Player Agent Actions

| Action | Description | Parameters |
|--------|-------------|------------|
| `DECLARE_ACTION` | State intended action | `action_type`, `target`, `details` |
| `ROLL_DICE` | Execute a dice roll | `dice`, `modifier`, `purpose` |
| `MOVE_TOKEN` | Move on the map | `destination`, `path` |
| `USE_ABILITY` | Activate class/race ability | `ability`, `target` |
| `CAST_SPELL` | Cast a spell | `spell`, `level`, `target` |
| `INTERACT` | Interact with environment/NPC | `target`, `method` |
| `ROLEPLAY` | Speak/emote in character | `text`, `emotion` |

### 4.3 Agent Communication Protocol

```typescript
interface GameMessage {
  type: 'dm_narration' | 'player_action' | 'roll_result' | 'state_update';
  source: string;  // Agent ID or 'system'
  target?: string; // Specific recipient or 'all'
  content: {
    text: string;
    action?: ActionData;
    roll?: RollResult;
    stateChanges?: StateChange[];
  };
  timestamp: number;
}
```

---

## 5. VTT Design

### 5.1 Custom VTT Architecture

Purpose-built virtual tabletop optimized for D&D 5e with AI integration.

#### 5.1.1 Core Technology Stack
- **Frontend**: React 18 + TypeScript
- **Canvas Rendering**: HTML5 Canvas or PixiJS for map/tokens
- **Real-time Sync**: Socket.io for multiplayer state
- **State Management**: Zustand (lightweight, good for real-time)
- **Styling**: Tailwind CSS + shadcn/ui components

#### 5.1.2 VTT Features

| Feature | Description | Priority |
|---------|-------------|----------|
| **Battle Map Canvas** | Grid-based map with pan/zoom | P0 |
| **Token System** | Draggable tokens with HP bars, conditions | P0 |
| **Initiative Tracker** | Turn order display, current turn highlight | P0 |
| **Dice Roller** | Visual dice with animation, roll history | P0 |
| **Chat/Narration Log** | DM narration, player actions, roll results | P0 |
| **Character Sheet Panel** | View/edit character stats | P0 |
| **Fog of War** | DM-controlled visibility | P1 |
| **Distance Measurement** | Grid-based ruler tool | P1 |
| **Spell/Ability Cards** | Quick reference cards | P1 |
| **Campaign Journal** | Session history, notes | P1 |
| **Map Editor** | DM can create/import maps | P2 |

#### 5.1.3 Token System

```typescript
interface VTTToken {
  id: string;
  entityId: string;           // Links to Character/Monster
  entityType: 'pc' | 'npc' | 'monster';
  
  // Visual
  imageUrl: string;
  size: 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan';
  color?: string;             // Ring color for identification
  
  // Position
  position: { x: number; y: number };  // Grid coordinates
  
  // Status
  hp: { current: number; max: number };
  conditions: Condition[];
  initiative?: number;
  
  // Visibility
  visibility: 'all' | 'dm_only' | 'owner_only';
  isSelected: boolean;
  
  // Movement
  movementRemaining: number;
  movementPath?: Position[];  // For showing planned movement
}
```

#### 5.1.4 Map System

```typescript
interface BattleMap {
  id: string;
  name: string;
  
  // Dimensions
  gridWidth: number;          // Number of squares wide
  gridHeight: number;         // Number of squares tall
  gridSize: number;           // Pixels per grid square (default 50)
  
  // Background
  backgroundImage?: string;   // URL to map image
  backgroundColor: string;    // Fallback color
  
  // Grid
  showGrid: boolean;
  gridColor: string;
  gridOpacity: number;
  
  // Terrain (for movement/cover calculations)
  terrain: TerrainType[][];   // 2D array matching grid
  
  // Fog of War
  fogOfWar: boolean[][];      // true = revealed
  
  // Placed tokens
  tokens: VTTToken[];
  
  // Environment markers
  markers: MapMarker[];       // Traps, notes, area effects
}

type TerrainType = 
  | 'normal'
  | 'difficult'      // Half movement
  | 'water_shallow'  // Difficult terrain
  | 'water_deep'     // Swimming required
  | 'wall'           // Impassable
  | 'pit'            // Fall damage
  | 'elevation';     // Height difference
```

### 5.2 VTT-Agent Integration

```typescript
// WebSocket event handlers
class VTTSocketHandler {
  private socket: Socket;
  private gameCoordinator: GameCoordinator;
  
  constructor(socket: Socket, coordinator: GameCoordinator) {
    this.socket = socket;
    this.gameCoordinator = coordinator;
    this.setupHandlers();
  }
  
  private setupHandlers() {
    // Human player actions
    this.socket.on('player_action', async (data: PlayerActionEvent) => {
      await this.gameCoordinator.handlePlayerAction(data);
    });
    
    // Human player moves token
    this.socket.on('move_token', async (data: MoveTokenEvent) => {
      await this.gameCoordinator.handleTokenMove(data);
    });
    
    // Human player rolls dice
    this.socket.on('roll_dice', async (data: RollDiceEvent, callback) => {
      const result = await this.gameCoordinator.handleDiceRoll(data);
      callback(result);
    });
    
    // Human player chat message
    this.socket.on('chat_message', async (data: ChatMessageEvent) => {
      await this.gameCoordinator.handleChatMessage(data);
    });
  }
  
  // Broadcast state updates to all connected clients
  broadcastStateUpdate(update: StateUpdate) {
    this.socket.emit('state_update', update);
  }
  
  // Send narration to chat
  sendNarration(text: string, speaker: string) {
    this.socket.emit('narration', { text, speaker, timestamp: Date.now() });
  }
  
  // Animate dice roll
  animateDiceRoll(roll: DiceRollResult) {
    this.socket.emit('dice_animation', roll);
  }
  
  // Update token position (with optional animation)
  updateToken(tokenId: string, changes: Partial<VTTToken>, animate = true) {
    this.socket.emit('token_update', { tokenId, changes, animate });
  }
}
```

### 5.3 UI Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ELIZA DUNGEONS                    Campaign: The Lost Mines   [⚙] [?]  │
├─────────────────────────────────────────────────────────────────────────┤
│  [Party] [Journal] [Compendium]                      Session 5 | 2:34:12│
├────────────────────────────────────────┬────────────────────────────────┤
│                                        │  ⚔️ INITIATIVE                 │
│                                        │  ┌────────────────────────┐    │
│                                        │  │ ► 1. Thorin (18)  ❤️24│    │
│         BATTLE MAP                     │  │   2. Goblin Boss (15)  │    │
│                                        │  │   3. Elara (12)   ❤️18│    │
│    ┌─────────────────────────┐         │  │   4. Goblin x2 (8)     │    │
│    │  [Grid with tokens]     │         │  │   5. Marcus (7)   ❤️32│    │
│    │                         │         │  └────────────────────────┘    │
│    │   🧙 ⚔️                 │         ├────────────────────────────────┤
│    │      👹  👹             │         │  📋 THORIN IRONFORGE           │
│    │         🛡️              │         │  Dwarf Fighter 3               │
│    │                         │         │  ──────────────────────        │
│    └─────────────────────────┘         │  HP: 24/32  AC: 18             │
│    [Zoom: 100%] [Measure] [Fog]        │  Speed: 25ft                   │
│                                        │  ──────────────────────        │
│                                        │  STR 16 (+3)  INT 10 (+0)      │
│                                        │  DEX 14 (+2)  WIS 12 (+1)      │
│                                        │  CON 15 (+2)  CHA  8 (-1)      │
│                                        │  ──────────────────────        │
│                                        │  [Actions] [Inventory] [Notes] │
├────────────────────────────────────────┴────────────────────────────────┤
│  📜 ADVENTURE LOG                                                 [🎲]  │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ DM: The goblin chieftain snarls, raising a notched scimitar. "You  ││
│  │ dare enter MY domain, surface dwellers?"                           ││
│  │                                                                     ││
│  │ Thorin: "Aye, and we'll be leaving with your head, beast!"         ││
│  │                                                                     ││
│  │ 🎲 Thorin rolls Initiative: d20+2 = 18                             ││
│  │ 🎲 Elara rolls Initiative: d20+3 = 12                              ││
│  │ ═══════════════════════════════════════════════════════════════════││
│  │ COMBAT BEGINS - Round 1                                            ││
│  │ ═══════════════════════════════════════════════════════════════════││
│  │ Thorin's turn. What do you do?                                     ││
│  └─────────────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ > I charge the chieftain and attack with my battleaxe!             ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.4 Component Architecture

```
src/vtt/
├── components/
│   ├── VTTApp.tsx                 # Main app container
│   ├── BattleMap/
│   │   ├── BattleMap.tsx          # Canvas-based map
│   │   ├── Token.tsx              # Individual token component
│   │   ├── Grid.tsx               # Grid overlay
│   │   ├── FogOfWar.tsx           # Fog layer
│   │   └── MeasureTool.tsx        # Distance measurement
│   ├── InitiativeTracker/
│   │   ├── InitiativeTracker.tsx  # Turn order panel
│   │   └── InitiativeEntry.tsx    # Single combatant entry
│   ├── CharacterSheet/
│   │   ├── CharacterSheet.tsx     # Full sheet panel
│   │   ├── AbilityScores.tsx      # Ability score display
│   │   ├── CombatStats.tsx        # AC, HP, speed
│   │   ├── ActionsPanel.tsx       # Available actions
│   │   └── InventoryPanel.tsx     # Equipment/items
│   ├── AdventureLog/
│   │   ├── AdventureLog.tsx       # Chat/narration container
│   │   ├── NarrationEntry.tsx     # DM narration
│   │   ├── PlayerEntry.tsx        # Player actions/speech
│   │   ├── RollEntry.tsx          # Dice roll results
│   │   └── ChatInput.tsx          # User input
│   ├── DiceRoller/
│   │   ├── DiceRoller.tsx         # Dice rolling UI
│   │   ├── DiceAnimation.tsx      # 3D dice animation
│   │   └── RollHistory.tsx        # Recent rolls
│   └── Shared/
│       ├── HPBar.tsx              # Health bar component
│       ├── ConditionBadge.tsx     # Status effect badge
│       └── Tooltip.tsx            # Info tooltips
├── hooks/
│   ├── useGameState.ts            # Global game state
│   ├── useSocket.ts               # WebSocket connection
│   ├── useTokenDrag.ts            # Token drag-and-drop
│   └── useDiceRoll.ts             # Dice rolling logic
├── stores/
│   ├── gameStore.ts               # Zustand game state
│   ├── uiStore.ts                 # UI state (selected token, panels)
│   └── chatStore.ts               # Chat/narration history
└── utils/
    ├── canvas.ts                  # Canvas rendering utilities
    ├── grid.ts                    # Grid calculations
    └── dice.ts                    # Dice parsing/rolling
```

---

## 6. Data Models

### 6.1 Character Sheet

```typescript
interface CharacterSheet {
  id: string;
  name: string;
  race: Race;
  class: CharacterClass;
  level: number;
  background: string;
  alignment: Alignment;
  
  // Ability Scores
  abilities: {
    strength: number;
    dexterity: number;
    constitution: number;
    intelligence: number;
    wisdom: number;
    charisma: number;
  };
  
  // Derived Stats
  proficiencyBonus: number;
  armorClass: number;
  initiative: number;
  speed: number;
  hitPoints: { current: number; max: number; temp: number };
  hitDice: { current: number; max: number; type: DieType };
  
  // Proficiencies
  savingThrows: AbilityName[];
  skills: Skill[];
  tools: string[];
  languages: string[];
  armor: ArmorType[];
  weapons: WeaponType[];
  
  // Equipment
  inventory: InventoryItem[];
  equipment: EquippedItems;
  currency: Currency;
  
  // Features
  features: Feature[];
  traits: string[];
  
  // Spellcasting (if applicable)
  spellcasting?: {
    ability: AbilityName;
    spellSaveDC: number;
    spellAttackBonus: number;
    spellSlots: SpellSlots;
    knownSpells: Spell[];
    preparedSpells: Spell[];
  };
  
  // Personality
  personalityTraits: string[];
  ideals: string;
  bonds: string;
  flaws: string;
  
  // Meta
  experiencePoints: number;
  isAI: boolean;
  agentId?: string;  // ElizaOS agent ID if AI-controlled
}
```

### 6.2 Monster/NPC

```typescript
interface Monster {
  id: string;
  name: string;
  type: MonsterType;
  size: Size;
  alignment: Alignment;
  
  armorClass: number;
  hitPoints: { current: number; max: number; formula: string };
  speed: { walk: number; fly?: number; swim?: number; burrow?: number };
  
  abilities: AbilityScores;
  
  savingThrows?: Partial<AbilityScores>;
  skills?: Partial<Record<Skill, number>>;
  
  damageResistances?: DamageType[];
  damageImmunities?: DamageType[];
  conditionImmunities?: Condition[];
  
  senses: {
    darkvision?: number;
    blindsight?: number;
    tremorsense?: number;
    truesight?: number;
    passivePerception: number;
  };
  
  languages: string[];
  challengeRating: number;
  experiencePoints: number;
  
  traits: MonsterTrait[];
  actions: MonsterAction[];
  legendaryActions?: LegendaryAction[];
  
  // Visual
  imageUrl?: string;
  tokenUrl?: string;
}
```

### 6.3 Game State

```typescript
interface GameState {
  id: string;
  campaignId: string;
  
  // Phase
  phase: 'exploration' | 'social' | 'combat' | 'rest';
  
  // Location
  currentLocation: Location;
  currentMap?: BattleMap;
  
  // Party
  party: CharacterSheet[];
  partyPositions: Map<string, Position>;
  
  // Combat (when in combat phase)
  combat?: {
    round: number;
    turnIndex: number;
    initiativeOrder: InitiativeEntry[];
    enemies: Monster[];
    enemyPositions: Map<string, Position>;
    combatLog: CombatLogEntry[];
  };
  
  // World State
  time: GameTime;
  weather?: Weather;
  
  // Session
  sessionLog: GameMessage[];
  activeEffects: ActiveEffect[];
}

interface InitiativeEntry {
  entityId: string;
  entityType: 'pc' | 'npc' | 'monster';
  initiative: number;
  hasActed: boolean;
  conditions: Condition[];
}
```

### 6.4 Location/Map

```typescript
interface Location {
  id: string;
  name: string;
  type: 'dungeon' | 'town' | 'wilderness' | 'building';
  description: string;
  
  // Connections
  connections: LocationConnection[];
  
  // NPCs/Monsters present
  inhabitants: string[];  // Entity IDs
  
  // Items/Treasure
  loot: LootTable;
  
  // Environmental
  lighting: 'bright' | 'dim' | 'dark';
  terrain: TerrainType;
  hazards?: Hazard[];
  
  // Visual
  imageUrl?: string;
  battleMapId?: string;
}

interface BattleMap {
  id: string;
  name: string;
  width: number;    // Grid squares
  height: number;
  gridSize: number; // Pixels per square
  
  backgroundImage: string;
  
  // Terrain
  terrain: TerrainCell[][];
  
  // Fog of War
  fogOfWar: boolean[][];
  
  // Placed items
  items: DnDGameItem[];
}
```

---

## 7. Turn & Round System

### 7.1 Game Phases

```
┌─────────────────────────────────────────────────────────────────┐
│                      GAME PHASE STATE MACHINE                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────┐    encounter    ┌──────────┐                     │
│   │EXPLORATION│───────────────►│  COMBAT  │                     │
│   └────┬─────┘◄───────────────┴────┬─────┘                     │
│        │         combat ends       │                            │
│        │                           │                            │
│   talk │                           │                            │
│   to   │                           │ short/long                 │
│   NPC  ▼                           │ rest                       │
│   ┌──────────┐                     ▼                            │
│   │  SOCIAL  │                ┌──────────┐                      │
│   └────┬─────┘                │   REST   │                      │
│        │                      └────┬─────┘                      │
│        └───────────────────────────┴───────► back to            │
│                                              exploration        │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Exploration Phase

**DM Controls:**
- Scene narration
- NPC dialogues
- Environmental descriptions
- Random encounters
- Treasure discovery

**Player Actions:**
- Movement (describe or map-based)
- Investigation/Perception checks
- Object interaction
- NPC conversation
- Rest initiation

**Flow:**
```
1. DM describes scene
2. Players declare actions (free-form, no strict turn order)
3. DM requests rolls as needed
4. DM narrates results
5. Repeat or transition to combat/social
```

### 7.3 Combat Phase

**Round Structure (6 seconds of in-game time):**

```typescript
interface CombatRound {
  roundNumber: number;
  
  phases: [
    'START_OF_ROUND',      // Trigger start-of-round effects
    'TURNS',               // Each combatant acts in initiative order
    'END_OF_ROUND',        // Trigger end-of-round effects, conditions tick
  ];
}
```

**Turn Structure:**

```typescript
interface CombatTurn {
  entityId: string;
  
  available: {
    movement: number;      // Remaining speed
    action: boolean;       // Standard action available
    bonusAction: boolean;  // Bonus action available
    reaction: boolean;     // Reaction available (resets at turn start)
    freeInteraction: boolean;
  };
  
  phases: [
    'START_OF_TURN',       // Effects that trigger, legendary actions refresh
    'MOVEMENT_AND_ACTIONS', // Player/AI decides what to do
    'END_OF_TURN',         // Concentration checks, etc.
  ];
}
```

**Initiative & Turn Order:**

```typescript
// Combat initialization
async function startCombat(enemies: Monster[], party: CharacterSheet[]) {
  const initiativeOrder: InitiativeEntry[] = [];
  
  // Roll initiative for all combatants
  for (const pc of party) {
    const roll = await rollD20();
    const initiative = roll + getModifier(pc.abilities.dexterity);
    initiativeOrder.push({
      entityId: pc.id,
      entityType: 'pc',
      initiative,
      hasActed: false,
      conditions: [],
    });
  }
  
  for (const enemy of enemies) {
    const roll = await rollD20();
    const initiative = roll + getModifier(enemy.abilities.dexterity);
    initiativeOrder.push({
      entityId: enemy.id,
      entityType: 'monster',
      initiative,
      hasActed: false,
      conditions: [],
    });
  }
  
  // Sort by initiative (highest first), resolve ties
  initiativeOrder.sort((a, b) => {
    if (b.initiative !== a.initiative) return b.initiative - a.initiative;
    // Tie-breaker: higher DEX goes first
    return getEntityDex(b.entityId) - getEntityDex(a.entityId);
  });
  
  return initiativeOrder;
}
```

**Combat Resolution Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│                     COMBAT TURN FLOW                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. DETERMINE CURRENT COMBATANT                                 │
│     └─► Check initiative order, skip incapacitated              │
│                                                                 │
│  2. START OF TURN EFFECTS                                       │
│     └─► Process conditions (save vs poison, etc.)               │
│                                                                 │
│  3. COMBATANT DECIDES ACTION                                    │
│     ├─► Human Player: Wait for input via VTT                    │
│     ├─► AI Player: Agent decides based on situation             │
│     └─► Monster: DM Agent controls                              │
│                                                                 │
│  4. RESOLVE ACTION                                              │
│     ├─► Attack: Roll d20, compare to AC, roll damage            │
│     ├─► Spell: Apply spell effects, saves, damage               │
│     ├─► Movement: Update position on map                        │
│     └─► Other: DM adjudicates                                   │
│                                                                 │
│  5. END OF TURN                                                 │
│     └─► Concentration checks, effect durations                  │
│                                                                 │
│  6. ADVANCE TO NEXT COMBATANT                                   │
│     └─► If all have acted, start new round                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 7.4 Social Phase

**DM Controls:**
- NPC personality and reactions
- Dialogue options (for AI players)
- Skill check DCs for persuasion/deception/intimidation

**Player Actions:**
- Dialogue choices
- Persuasion/Deception/Intimidation attempts
- Insight checks to read NPCs
- Gift giving, bribery

**Flow:**
```
1. Player initiates conversation
2. DM (as NPC) responds in character
3. Player chooses approach/dialogue
4. DM may request social skill checks
5. Resolution affects NPC disposition/game state
```

### 7.5 Rest Phase

**Short Rest (1 hour):**
```typescript
async function shortRest(party: CharacterSheet[]) {
  for (const pc of party) {
    // Player decides how many hit dice to spend
    const hitDiceToSpend = await getPlayerInput(pc, 'hit_dice_count');
    
    for (let i = 0; i < hitDiceToSpend; i++) {
      if (pc.hitDice.current > 0) {
        const healing = rollDie(pc.hitDice.type) + getModifier(pc.abilities.constitution);
        pc.hitPoints.current = Math.min(pc.hitPoints.max, pc.hitPoints.current + healing);
        pc.hitDice.current--;
      }
    }
    
    // Recover short-rest abilities (Fighter's Second Wind, etc.)
    recoverShortRestAbilities(pc);
  }
}
```

**Long Rest (8 hours):**
```typescript
async function longRest(party: CharacterSheet[]) {
  for (const pc of party) {
    // Full HP recovery
    pc.hitPoints.current = pc.hitPoints.max;
    
    // Recover half hit dice (minimum 1)
    const recovered = Math.max(1, Math.floor(pc.hitDice.max / 2));
    pc.hitDice.current = Math.min(pc.hitDice.max, pc.hitDice.current + recovered);
    
    // Recover all spell slots
    if (pc.spellcasting) {
      pc.spellcasting.spellSlots = getMaxSpellSlots(pc.class, pc.level);
    }
    
    // Recover all abilities
    recoverAllAbilities(pc);
  }
}
```

---

## 8. Campaign Persistence

### 8.1 Overview

The campaign system enables multi-session play with persistent world state, character progression, NPC relationships, and narrative continuity. Both the DM agent and player agents remember past sessions.

### 8.2 Database Schema

```sql
-- Campaigns table
CREATE TABLE campaigns (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  dm_agent_id UUID NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  settings JSONB DEFAULT '{}'::jsonb
);

-- Sessions table (individual play sessions)
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  session_number INTEGER NOT NULL,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  summary TEXT,                    -- AI-generated session summary
  key_events JSONB DEFAULT '[]'::jsonb,
  state_snapshot JSONB             -- Full game state at session end
);

-- Characters table (PCs)
CREATE TABLE characters (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  player_type VARCHAR(20) NOT NULL, -- 'human' or 'ai'
  agent_id UUID,                     -- ElizaOS agent ID if AI
  sheet JSONB NOT NULL,              -- Full character sheet
  memories JSONB DEFAULT '[]'::jsonb, -- Character-specific memories
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- NPCs table
CREATE TABLE npcs (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  personality TEXT,
  stats JSONB,                       -- Monster/NPC stat block if applicable
  location_id UUID,
  disposition JSONB DEFAULT '{}'::jsonb, -- Attitude toward each PC
  memories JSONB DEFAULT '[]'::jsonb,
  is_alive BOOLEAN DEFAULT TRUE
);

-- Locations table
CREATE TABLE locations (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50),                  -- 'town', 'dungeon', 'wilderness', etc.
  parent_id UUID REFERENCES locations(id), -- For nested locations
  connections JSONB DEFAULT '[]'::jsonb,   -- Connected location IDs
  discovered BOOLEAN DEFAULT FALSE,
  image_url TEXT,
  map_data JSONB                     -- Battle map if applicable
);

-- World events (things that happened in the campaign)
CREATE TABLE world_events (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  session_id UUID REFERENCES sessions(id),
  event_type VARCHAR(50) NOT NULL,   -- 'combat', 'discovery', 'dialogue', 'death', etc.
  description TEXT NOT NULL,
  participants JSONB DEFAULT '[]'::jsonb, -- Character/NPC IDs involved
  location_id UUID REFERENCES locations(id),
  timestamp_game JSONB,              -- In-game date/time
  timestamp_real TIMESTAMP DEFAULT NOW(),
  importance INTEGER DEFAULT 5       -- 1-10 scale for memory retrieval
);

-- Quest tracker
CREATE TABLE quests (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed', 'failed', 'abandoned'
  giver_npc_id UUID REFERENCES npcs(id),
  objectives JSONB DEFAULT '[]'::jsonb,
  rewards JSONB DEFAULT '{}'::jsonb,
  discovered_session INTEGER,
  completed_session INTEGER
);

-- Inventory/Items
CREATE TABLE items (
  id UUID PRIMARY KEY,
  campaign_id UUID REFERENCES campaigns(id),
  owner_id UUID,                     -- Character or NPC ID
  owner_type VARCHAR(20),            -- 'character', 'npc', 'location'
  item_data JSONB NOT NULL,          -- Full item definition
  equipped BOOLEAN DEFAULT FALSE
);
```

### 8.3 Memory System

#### 8.3.1 DM Agent Memory

The DM maintains campaign-level memory for narrative continuity:

```typescript
interface DMCampaignMemory {
  // World state
  worldState: {
    currentDate: GameDate;
    majorFactions: Faction[];
    activeThreats: Threat[];
    politicalClimate: string;
  };
  
  // NPC tracking
  npcRelationships: Map<string, NPCRelationship>;
  
  // Plot threads
  activeQuests: Quest[];
  plotHooks: PlotHook[];
  foreshadowing: ForeshadowingElement[];
  
  // Session-to-session continuity
  lastSessionSummary: string;
  unresolvedCliffhangers: string[];
  partyReputation: Map<string, number>; // Faction -> reputation
}

// DM retrieves relevant memories before each response
async function getDMContext(campaign: Campaign, currentSituation: string): Promise<string> {
  const relevantEvents = await retrieveRelevantEvents(campaign.id, currentSituation);
  const npcContext = await getNPCsInScene(campaign.id, currentLocation);
  const questContext = await getActiveQuests(campaign.id);
  
  return formatDMContext({
    events: relevantEvents,
    npcs: npcContext,
    quests: questContext,
    worldState: campaign.worldState,
  });
}
```

#### 8.3.2 Player Agent Memory

Each AI player character maintains personal memories:

```typescript
interface CharacterMemory {
  // Personal history
  backstory: string;
  personalGoals: string[];
  fears: string[];
  bonds: string[];          // Connections to other PCs/NPCs
  
  // Session memories
  significantMoments: Memory[];
  relationshipsWithParty: Map<string, Relationship>;
  npcOpinions: Map<string, Opinion>;
  
  // Tactical memory
  knownEnemyWeaknesses: Map<string, string>;
  preferredTactics: string[];
  
  // Emotional state
  currentMood: Mood;
  recentTraumas: string[];
  recentTriumphs: string[];
}

// Player agent retrieves character context before decisions
async function getCharacterContext(
  character: Character, 
  situation: string
): Promise<string> {
  const personalMemories = await retrieveCharacterMemories(character.id, situation);
  const partyRelationships = await getPartyRelationships(character.id);
  
  return formatCharacterContext({
    sheet: character.sheet,
    memories: personalMemories,
    relationships: partyRelationships,
    currentMood: character.currentMood,
    goals: character.personalGoals,
  });
}
```

### 8.4 Session Management

```typescript
interface SessionManager {
  // Start a new session
  async startSession(campaignId: string): Promise<Session> {
    const campaign = await getCampaign(campaignId);
    const lastSession = await getLastSession(campaignId);
    
    // Create new session
    const session = await createSession({
      campaignId,
      sessionNumber: (lastSession?.sessionNumber ?? 0) + 1,
      startedAt: new Date(),
    });
    
    // Load state from last session
    if (lastSession?.stateSnapshot) {
      await restoreGameState(lastSession.stateSnapshot);
    }
    
    // Inject "last time on..." context to DM
    if (lastSession?.summary) {
      await injectSessionRecap(session, lastSession.summary);
    }
    
    return session;
  }
  
  // End session with summary generation
  async endSession(sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    const events = await getSessionEvents(sessionId);
    
    // AI generates session summary
    const summary = await generateSessionSummary(events);
    
    // Save state snapshot
    const stateSnapshot = await captureGameState();
    
    await updateSession(sessionId, {
      endedAt: new Date(),
      summary,
      stateSnapshot,
      keyEvents: extractKeyEvents(events),
    });
    
    // Update character memories
    for (const character of await getPartyCharacters(session.campaignId)) {
      await updateCharacterMemories(character.id, events);
    }
  }
  
  // Generate "Previously on..." recap
  async generateSessionRecap(campaignId: string): Promise<string> {
    const recentSessions = await getRecentSessions(campaignId, 3);
    const majorEvents = await getMajorEvents(campaignId, 10);
    
    return await dmAgent.generateRecap({
      sessions: recentSessions,
      events: majorEvents,
    });
  }
}
```

### 8.5 Memory Retrieval

```typescript
// Semantic search for relevant memories
async function retrieveRelevantEvents(
  campaignId: string,
  currentContext: string,
  limit: number = 10
): Promise<WorldEvent[]> {
  // Use ElizaOS memory system with embeddings
  const embedding = await generateEmbedding(currentContext);
  
  const events = await db.query(`
    SELECT *, 
           1 - (embedding <=> $1) as similarity
    FROM world_events
    WHERE campaign_id = $2
    ORDER BY 
      similarity * importance DESC,
      timestamp_real DESC
    LIMIT $3
  `, [embedding, campaignId, limit]);
  
  return events;
}

// Get NPC context for current scene
async function getNPCContext(
  campaignId: string,
  locationId: string,
  involvedNpcs: string[]
): Promise<NPCContext[]> {
  const npcs = await db.query(`
    SELECT n.*, 
           (SELECT json_agg(we.*) 
            FROM world_events we 
            WHERE $3 = ANY(we.participants)
            AND we.campaign_id = $1
            ORDER BY we.timestamp_real DESC
            LIMIT 5) as recent_interactions
    FROM npcs n
    WHERE n.campaign_id = $1
    AND (n.location_id = $2 OR n.id = ANY($3))
  `, [campaignId, locationId, involvedNpcs]);
  
  return npcs.map(formatNPCContext);
}
```

---

## 9. Image Generation

### 9.1 Integration Points

| Trigger | Content Generated | Priority |
|---------|-------------------|----------|
| New monster encountered | Monster illustration | High |
| Enter new location | Scene/environment art | High |
| Character creation | Character portrait | Medium |
| Major story moment | Narrative scene | Medium |
| Item discovery | Item illustration | Low |

### 9.2 Image Generation Service

```typescript
interface ImageGenerationService {
  provider: 'openai' | 'fal' | 'groq';
  
  generateMonster(monster: Monster): Promise<string>;
  generateScene(location: Location, mood: string): Promise<string>;
  generateCharacter(character: CharacterSheet): Promise<string>;
  generateItem(item: Item): Promise<string>;
}

// Prompt templates
const MONSTER_PROMPT_TEMPLATE = `
Fantasy illustration of a {size} {type} creature called "{name}".
{description}
Style: D&D fantasy art, detailed, dramatic lighting
Setting: {environment}
`;

const SCENE_PROMPT_TEMPLATE = `
Fantasy landscape illustration: {locationName}
{description}
Time: {timeOfDay}
Weather: {weather}
Style: D&D fantasy art, wide shot, detailed environment
`;

const CHARACTER_PROMPT_TEMPLATE = `
Fantasy character portrait: {name}, a {race} {class}
{physicalDescription}
Equipment: {equipment}
Expression: {mood}
Style: D&D fantasy art, detailed portrait, dramatic lighting
`;
```

### 9.3 Image Caching Strategy

```typescript
interface ImageCache {
  // Cache generated images by content hash
  monsters: Map<string, CachedImage>;
  locations: Map<string, CachedImage>;
  characters: Map<string, CachedImage>;
  
  // Store in database for persistence
  async saveToDb(type: string, id: string, url: string): Promise<void>;
  async getFromDb(type: string, id: string): Promise<string | null>;
  
  // Get or generate
  async getOrGenerate(
    type: string, 
    id: string, 
    prompt: string
  ): Promise<string> {
    // Check cache first
    const cached = await this.getFromDb(type, id);
    if (cached) return cached;
    
    // Generate new image
    const url = await this.generateImage(prompt);
    await this.saveToDb(type, id, url);
    return url;
  }
}
```

### 9.4 Provider Configuration

```typescript
const imageProviders = {
  openai: {
    model: 'dall-e-3',
    size: '1024x1024',
    quality: 'standard',
  },
  fal: {
    model: 'flux-pro',
    size: '1024x1024',
  },
};

// Select provider based on config
async function generateImage(prompt: string): Promise<string> {
  const provider = config.imageProvider || 'openai';
  
  switch (provider) {
    case 'openai':
      return await openai.images.generate({
        model: 'dall-e-3',
        prompt,
        size: '1024x1024',
      }).then(r => r.data[0].url);
      
    case 'fal':
      return await fal.run('fal-ai/flux-pro', {
        input: { prompt },
      }).then(r => r.images[0].url);
  }
}
```

---

## 10. Technical Implementation

### 10.1 Project Structure

```
examples/dnd-vtt/
├── GDD.md                          # This document
├── README.md                       # Setup instructions
├── package.json
├── tsconfig.json
├── docker-compose.yml              # PostgreSQL for dev
│
├── server/                         # Backend
│   ├── index.ts                    # Entry point
│   │
│   ├── agents/
│   │   ├── dm-agent.ts             # Dungeon Master agent
│   │   ├── player-agent.ts         # AI Player agent factory
│   │   └── character-templates/    # Pre-built character personalities
│   │       ├── fighter.ts
│   │       ├── rogue.ts
│   │       ├── wizard.ts
│   │       └── cleric.ts
│   │
│   ├── plugins/
│   │   ├── dnd-dm-plugin.ts        # DM actions/providers
│   │   ├── dnd-player-plugin.ts    # Player actions/providers
│   │   └── dnd-rules-plugin.ts     # Rules engine integration
│   │
│   ├── engine/
│   │   ├── game-coordinator.ts     # Turn/state management
│   │   ├── combat-engine.ts        # Combat resolution
│   │   ├── session-manager.ts      # Campaign session handling
│   │   ├── dice.ts                 # Dice rolling utilities
│   │   └── rules/
│   │       ├── abilities.ts        # Ability score calculations
│   │       ├── combat.ts           # Attack/damage rules
│   │       ├── spells.ts           # Spell effects
│   │       └── conditions.ts       # Status effect handling
│   │
│   ├── persistence/
│   │   ├── database.ts             # PostgreSQL connection
│   │   ├── migrations/             # Database migrations
│   │   ├── repositories/
│   │   │   ├── campaign.ts
│   │   │   ├── character.ts
│   │   │   ├── session.ts
│   │   │   ├── npc.ts
│   │   │   └── world-event.ts
│   │   └── memory-retrieval.ts     # Semantic memory search
│   │
│   ├── services/
│   │   ├── image-generation.ts     # AI image generation
│   │   ├── websocket.ts            # Socket.io server
│   │   └── session-summary.ts      # AI session summarization
│   │
│   ├── data/
│   │   ├── srd/
│   │   │   ├── classes.json        # SRD class data
│   │   │   ├── races.json          # SRD race data
│   │   │   ├── spells.json         # SRD spells
│   │   │   ├── monsters.json       # SRD monsters
│   │   │   └── items.json          # SRD items
│   │   │
│   │   └── adventures/
│   │       └── starter/            # Starter adventure content
│   │           ├── adventure.json
│   │           ├── maps/
│   │           └── npcs/
│   │
│   └── types/
│       ├── character.ts
│       ├── monster.ts
│       ├── game-state.ts
│       ├── combat.ts
│       ├── campaign.ts
│       └── vtt.ts
│
├── client/                         # Frontend VTT
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── index.html
│   │
│   └── src/
│       ├── main.tsx                # Entry point
│       ├── App.tsx                 # Root component
│       │
│       ├── components/
│       │   ├── VTTApp.tsx          # Main VTT container
│       │   ├── BattleMap/
│       │   │   ├── BattleMap.tsx
│       │   │   ├── Token.tsx
│       │   │   ├── Grid.tsx
│       │   │   └── FogOfWar.tsx
│       │   ├── InitiativeTracker/
│       │   │   └── InitiativeTracker.tsx
│       │   ├── CharacterSheet/
│       │   │   └── CharacterSheet.tsx
│       │   ├── AdventureLog/
│       │   │   ├── AdventureLog.tsx
│       │   │   └── ChatInput.tsx
│       │   └── DiceRoller/
│       │       └── DiceRoller.tsx
│       │
│       ├── hooks/
│       │   ├── useGameState.ts
│       │   ├── useSocket.ts
│       │   └── useTokenDrag.ts
│       │
│       ├── stores/
│       │   ├── gameStore.ts
│       │   └── uiStore.ts
│       │
│       └── utils/
│           ├── canvas.ts
│           ├── grid.ts
│           └── dice.ts
│
└── tests/
    ├── engine/
    ├── agents/
    ├── persistence/
    └── integration/
```

### 10.2 ElizaOS Plugin Implementation

```typescript
// server/plugins/dnd-dm-plugin.ts
import {
  type Plugin,
  type Action,
  type Provider,
  type Service,
  type IAgentRuntime,
} from "@elizaos/core";

export const dndDungeonMasterPlugin: Plugin = {
  name: "dnd-dungeon-master",
  description: "D&D 5e Dungeon Master capabilities with campaign memory",
  
  actions: [
    describeSceneAction,
    requestRollAction,
    resolveAttackAction,
    applyDamageAction,
    controlNPCAction,
    startCombatAction,
    advanceTurnAction,
    endCombatAction,
    generateImageAction,
    updateMapAction,
    saveSessionAction,
    loadSessionAction,
  ],
  
  providers: [
    gameStateProvider,
    partyStatusProvider,
    encounterStateProvider,
    locationContextProvider,
    campaignMemoryProvider,      // Retrieves relevant campaign history
    npcRelationshipProvider,     // NPC attitudes and past interactions
    questStateProvider,          // Active quests and objectives
  ],
  
  services: [
    GameCoordinatorService,
    SessionManagerService,
    ImageGenerationService,
  ],
  
  init: async (config, runtime) => {
    // Load SRD data
    await loadSRDData(runtime);
    
    // Connect to campaign database
    await initializeCampaignDB(runtime);
    
    // Initialize or restore game state
    await initializeGameState(runtime);
  },
};
```

### 10.3 Game Coordinator Service

```typescript
// server/engine/game-coordinator.ts
import { Service, type IAgentRuntime, EventEmitter } from "@elizaos/core";
import { SessionManager } from './session-manager';
import { CampaignRepository } from '../persistence/repositories/campaign';

class GameCoordinatorService extends Service {
  static serviceType = "dnd_game_coordinator";
  
  private gameState: GameState;
  private dmRuntime: IAgentRuntime;
  private playerRuntimes: Map<string, IAgentRuntime>;
  private eventBus: EventEmitter;
  private sessionManager: SessionManager;
  private campaignRepo: CampaignRepository;
  
  async initialize(
    campaignId: string,
    dmRuntime: IAgentRuntime,
    playerConfigs: PlayerConfig[]
  ): Promise<void> {
    this.dmRuntime = dmRuntime;
    this.playerRuntimes = new Map();
    this.campaignRepo = new CampaignRepository();
    this.sessionManager = new SessionManager(campaignId);
    
    // Load campaign from database
    const campaign = await this.campaignRepo.getCampaign(campaignId);
    
    // Initialize AI player agents with their character memories
    for (const config of playerConfigs.filter(p => p.isAI)) {
      const characterMemory = await this.loadCharacterMemory(config.characterId);
      const runtime = await createPlayerAgentRuntime(config, characterMemory);
      this.playerRuntimes.set(config.characterId, runtime);
    }
    
    // Start new session
    await this.sessionManager.startSession();
    
    // Set up event handlers
    this.setupEventHandlers();
  }
  
  async handlePlayerAction(playerId: string, action: PlayerAction): Promise<void> {
    // Validate action is legal
    const validation = await this.validateAction(playerId, action);
    if (!validation.valid) {
      this.eventBus.emit('action_rejected', { playerId, reason: validation.reason });
      return;
    }
    
    // Execute action through rules engine
    const result = await this.executeAction(playerId, action);
    
    // Update game state
    this.applyStateChanges(result.stateChanges);
    
    // Record event for campaign history
    await this.recordWorldEvent({
      type: 'player_action',
      description: result.narrativeDescription,
      participants: [playerId],
      importance: result.significance,
    });
    
    // Notify DM agent of player action
    await this.notifyDM(playerId, action, result);
    
    // Broadcast state update to all clients
    this.broadcastStateUpdate();
    
    // If in combat, check if turn should advance
    if (this.gameState.phase === 'combat') {
      await this.checkTurnAdvance();
    }
  }
  
  async runAIPlayerTurn(characterId: string): Promise<void> {
    const playerRuntime = this.playerRuntimes.get(characterId);
    if (!playerRuntime) return;
    
    // Get character context including memories
    const context = await this.buildCharacterContext(characterId);
    
    // Let AI decide action
    await playerRuntime.messageService?.handleMessage(
      playerRuntime,
      createTurnPromptMessage(characterId, this.gameState, context),
      async (response) => {
        await this.handlePlayerResponse(characterId, response);
        return [];
      }
    );
  }
  
  async runMonsterTurn(monsterId: string): Promise<void> {
    // DM agent controls all monsters
    const monsterContext = await this.buildMonsterContext(monsterId);
    
    await this.dmRuntime.messageService?.handleMessage(
      this.dmRuntime,
      createMonsterTurnMessage(monsterId, this.gameState, monsterContext),
      async (response) => {
        await this.handleDMResponse(response);
        return [];
      }
    );
  }
  
  async endSession(): Promise<SessionSummary> {
    // Generate and save session summary
    const summary = await this.sessionManager.endSession();
    
    // Update all character memories with session events
    for (const [charId, runtime] of this.playerRuntimes) {
      await this.updateCharacterMemory(charId, summary.events);
    }
    
    return summary;
  }
  
  private async recordWorldEvent(event: Partial<WorldEvent>): Promise<void> {
    await this.campaignRepo.recordEvent({
      ...event,
      campaignId: this.gameState.campaignId,
      sessionId: this.sessionManager.currentSessionId,
      locationId: this.gameState.currentLocation.id,
      timestampGame: this.gameState.time,
    });
  }
}
```

### 10.4 WebSocket Server

```typescript
// server/services/websocket.ts
import { Server } from "socket.io";
import { GameCoordinator } from "../engine/game-coordinator";

export function setupWebSocketServer(
  httpServer: http.Server,
  coordinator: GameCoordinator
): Server {
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });
  
  io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);
    
    // Join campaign room
    socket.on("join_campaign", async (campaignId: string, playerId: string) => {
      socket.join(`campaign:${campaignId}`);
      
      // Send current game state
      const state = await coordinator.getGameState();
      socket.emit("game_state", state);
    });
    
    // Human player action
    socket.on("player_action", async (data: PlayerActionEvent) => {
      await coordinator.handlePlayerAction(data.playerId, data.action);
    });
    
    // Human player moves token
    socket.on("move_token", async (data: MoveTokenEvent) => {
      await coordinator.handleTokenMove(data.tokenId, data.destination);
    });
    
    // Human player rolls dice
    socket.on("roll_dice", async (data: RollDiceEvent, callback) => {
      const result = await coordinator.handleDiceRoll(data);
      callback(result);
      
      // Broadcast roll to all players
      io.to(`campaign:${data.campaignId}`).emit("dice_result", result);
    });
    
    // Human player sends chat message
    socket.on("chat_message", async (data: ChatMessageEvent) => {
      await coordinator.handleChatMessage(data);
      io.to(`campaign:${data.campaignId}`).emit("chat_message", data);
    });
    
    // DM actions (human DM override)
    socket.on("dm_action", async (data: DMActionEvent) => {
      // Verify player is DM
      if (await coordinator.isPlayerDM(data.playerId)) {
        await coordinator.handleDMAction(data);
      }
    });
    
    socket.on("disconnect", () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });
  
  // Coordinator broadcasts state updates
  coordinator.on("state_update", (update: StateUpdate) => {
    io.to(`campaign:${update.campaignId}`).emit("state_update", update);
  });
  
  coordinator.on("narration", (data: NarrationEvent) => {
    io.to(`campaign:${data.campaignId}`).emit("narration", data);
  });
  
  coordinator.on("combat_start", (data: CombatStartEvent) => {
    io.to(`campaign:${data.campaignId}`).emit("combat_start", data);
  });
  
  return io;
}
```

### 10.5 Dependencies

```json
{
  "name": "eliza-dungeons",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["server", "client"],
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "cd server && bun run dev",
    "dev:client": "cd client && npm run dev",
    "build": "npm run build:server && npm run build:client",
    "db:migrate": "cd server && bun run migrate"
  }
}

// server/package.json
{
  "dependencies": {
    "@elizaos/core": "workspace:*",
    "@elizaos/plugin-sql": "workspace:*",
    "@elizaos/plugin-openai": "workspace:*",
    "socket.io": "^4.7.0",
    "pg": "^8.11.0",
    "drizzle-orm": "^0.29.0",
    "zod": "^3.22.0",
    "openai": "^4.20.0"
  }
}

// client/package.json
{
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "socket.io-client": "^4.7.0",
    "zustand": "^4.4.0",
    "@tanstack/react-query": "^5.0.0",
    "tailwindcss": "^3.4.0",
    "pixi.js": "^8.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "@types/react": "^18.2.0"
  }
}

---

## 11. Risks & Unknowns

### 11.1 Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **LLM Latency** | Slow turns, poor UX | Stream responses, show typing indicators, cache common responses |
| **State Consistency** | Desync between VTT and agents | Single source of truth in GameCoordinator, optimistic UI updates |
| **Custom VTT Complexity** | Significant frontend work | Start with minimal viable VTT, iterate |
| **Campaign Memory Retrieval** | Irrelevant/wrong memories surface | Tune embedding similarity, importance weighting, test thoroughly |
| **Image Generation Costs** | High API costs at scale | Cache aggressively, generate only on-demand, offer image-free mode |
| **Multi-Agent Coordination** | Race conditions, out-of-order actions | Strict turn-based locking, message queuing |
| **Complex Rule Edge Cases** | Incorrect rulings | Start with core rules only, add edge cases incrementally |

### 11.2 Design Unknowns

| Unknown | Options to Explore |
|---------|-------------------|
| **AI Player Decision Quality** | Test different prompting strategies, add "reasoning" step before action |
| **AI Player Personality Consistency** | Character memory injection, personality reinforcement in prompts |
| **DM Narrative Consistency** | Experiment with memory systems, campaign context injection, plot threading |
| **Combat Pacing** | Tune AI response times, allow "auto-resolve" for trivial encounters |
| **Session Recap Quality** | Test different summarization prompts, key event extraction |
| **NPC Memory Depth** | How much NPC history to store, when to "forget" minor interactions |

### 11.3 Scope Risks

| Risk | Mitigation |
|------|------------|
| **Feature Creep** | Strict v1 scope, defer to v2 backlog |
| **Rules Completeness** | SRD-only, no homebrew hooks |
| **VTT Polish** | MVP features first, polish later |
| **Campaign Complexity** | Start with simple linear adventure, add branching later |

---

## 12. Development Roadmap

### Phase 1: Foundation (Weeks 1-2)

- [ ] Set up project structure (monorepo with server/client)
- [ ] Configure PostgreSQL and create database schema
- [ ] Implement core data models (Character, Monster, GameState, Campaign)
- [ ] Build dice rolling utilities
- [ ] Create basic rules engine (ability checks, attack rolls, damage)
- [ ] Load SRD data (classes, races, monsters, spells)

### Phase 2: DM Agent (Weeks 3-4)

- [ ] Implement DM agent with ElizaOS
- [ ] Create DM plugin with core actions
- [ ] Build narrative generation prompts
- [ ] Implement NPC/monster control
- [ ] Create campaign memory provider
- [ ] Test DM responses in isolation

### Phase 3: Combat System (Weeks 5-6)

- [ ] Implement initiative system
- [ ] Build turn management (Game Coordinator)
- [ ] Create combat actions (attack, cast spell, move)
- [ ] Implement damage, healing, death saves
- [ ] Add condition tracking
- [ ] Test combat flow end-to-end

### Phase 4: Player Agents (Weeks 7-8)

- [ ] Implement player agent factory
- [ ] Create player plugin with actions
- [ ] Build character decision-making prompts
- [ ] Implement character memory system
- [ ] Create personality templates (fighter, rogue, wizard, cleric)
- [ ] Test AI player combat behavior
- [ ] Test AI player roleplay behavior
- [ ] Test party coordination

### Phase 5: Campaign Persistence (Weeks 9-10)

- [ ] Implement session manager (start/end sessions)
- [ ] Build world event recording
- [ ] Create memory retrieval (semantic search)
- [ ] Implement session summary generation
- [ ] Build NPC relationship tracking
- [ ] Test multi-session continuity
- [ ] Create "Previously on..." recap system

### Phase 6: Custom VTT (Weeks 11-14)

- [ ] Set up React + Vite frontend
- [ ] Build battle map canvas (grid, pan, zoom)
- [ ] Implement token system with drag-and-drop
- [ ] Create initiative tracker component
- [ ] Build adventure log (chat/narration)
- [ ] Implement character sheet panel
- [ ] Create dice roller with animations
- [ ] Connect VTT to WebSocket server
- [ ] Implement fog of war (basic)

### Phase 7: Image Generation (Week 15)

- [ ] Implement image generation service
- [ ] Create prompt templates (monsters, scenes, characters)
- [ ] Build caching layer with DB persistence
- [ ] Integrate with game flow triggers

### Phase 8: Integration & Polish (Weeks 16-18)

- [ ] End-to-end playtesting (AI-only party)
- [ ] End-to-end playtesting (mixed party)
- [ ] Performance optimization
- [ ] Bug fixes and edge cases
- [ ] Documentation
- [ ] Create starter adventure ("The Goblin Caves")
- [ ] Create sample pre-generated characters

---

## Appendix A: D&D 5e SRD Quick Reference

### Ability Score Modifiers

| Score | Modifier |
|-------|----------|
| 1 | -5 |
| 2-3 | -4 |
| 4-5 | -3 |
| 6-7 | -2 |
| 8-9 | -1 |
| 10-11 | +0 |
| 12-13 | +1 |
| 14-15 | +2 |
| 16-17 | +3 |
| 18-19 | +4 |
| 20-21 | +5 |

### Proficiency Bonus by Level

| Level | Bonus |
|-------|-------|
| 1-4 | +2 |
| 5-8 | +3 |
| 9-12 | +4 |
| 13-16 | +5 |
| 17-20 | +6 |

### Conditions

- **Blinded**: Can't see, auto-fail sight checks, attacks have disadvantage, attacks against have advantage
- **Charmed**: Can't attack charmer, charmer has advantage on social checks
- **Deafened**: Can't hear, auto-fail hearing checks
- **Frightened**: Disadvantage while source visible, can't willingly move closer
- **Grappled**: Speed 0, ends if grappler incapacitated or moved apart
- **Incapacitated**: Can't take actions or reactions
- **Invisible**: Impossible to see, attacks against have disadvantage, attacks have advantage
- **Paralyzed**: Incapacitated, can't move or speak, auto-fail STR/DEX saves, attacks have advantage, hits are crits if within 5ft
- **Petrified**: Weight increases x10, incapacitated, unaware, attacks against have advantage, auto-fail STR/DEX saves, resistance to all damage, immune to poison/disease
- **Poisoned**: Disadvantage on attacks and ability checks
- **Prone**: Disadvantage on attacks, melee attacks against have advantage, ranged against have disadvantage, moving costs extra
- **Restrained**: Speed 0, attacks have disadvantage, attacks against have advantage, disadvantage on DEX saves
- **Stunned**: Incapacitated, can't move, can only speak falteringly, auto-fail STR/DEX saves, attacks against have advantage
- **Unconscious**: Incapacitated, can't move or speak, unaware, drop items, fall prone, auto-fail STR/DEX saves, attacks have advantage, melee hits are crits

---

## Appendix B: Example Game Session Flow

### Session Start (with campaign history)

```
═══════════════════════════════════════════════════════════════════════
ELIZA DUNGEONS - Campaign: The Lost Mines of Phandelver
Session 5 - Party: Thorin, Elara, Marcus, Zara (all AI)
═══════════════════════════════════════════════════════════════════════

DM: "Previously, in our last session..."

    📜 SESSION RECAP (AI-generated):
    The party discovered the location of the Goblin Caves from a captured
    scout. Thorin intimidated the goblin into revealing that their leader,
    Klarg, holds a dwarf prisoner. Elara recognized the description as
    Gundren Rockseeker, the party's employer. The party rested at the
    abandoned farmhouse and set out at dawn.

───────────────────────────────────────────────────────────────────────
EXPLORATION PHASE
───────────────────────────────────────────────────────────────────────

DM: "You stand before the entrance to the Goblin Caves. A narrow stream
    flows out of the cave mouth, and thick briars flank either side.
    The morning mist clings to the rocky hillside."

    [SCENE IMAGE GENERATED: dark cave entrance with stream]

Elara (AI - Elf Wizard): *examines the cave entrance carefully*
    "I sense residual magic here... old wards, perhaps. Everyone stay
    alert. Zara, can you check for tracks?"

Zara (AI - Halfling Rogue): *crouches low, examining the mud*
    "Goblin tracks. Lots of them. But also... boots. Human-sized.
    Someone was dragged inside recently."

    [Zara rolls Survival: d20+4 = 17 - Success]

Thorin (AI - Dwarf Fighter): "That'll be Gundren. We go in quiet-like,
    or we go in loud. I favor loud, but I'll defer to the group."

Marcus (AI - Human Cleric): "The Light of Lathander favors the bold,
    but perhaps stealth serves us better here. If they have a hostage..."

Elara: "Agreed. Zara takes point. I'll prepare Sleep in case we're
    spotted. Thorin, Marcus - stay close but let us handle first contact."

DM: "Zara, you slip into the cave. Make a Stealth check."

    [Zara rolls Stealth: d20+7 = 22]

DM: "You move like a shadow through the entrance tunnel. Twenty feet in,
    the passage opens into a larger chamber. Two goblins sit around a
    small fire, picking at some kind of roasted meat. They haven't
    noticed you. Beyond them, you see another passage heading deeper."

Zara: *holds up two fingers behind her, signaling the party, then
    gestures to ask if they should engage or sneak past*

DM: "The rest of the party can see Zara's signals. What do you do?"

Elara: *whispers* "We take them quietly. Zara, can you get behind them?
    I'll put them to sleep, and if that fails, we strike."

Thorin: *nods grimly, readying his battleaxe*

───────────────────────────────────────────────────────────────────────
COMBAT BEGINS
───────────────────────────────────────────────────────────────────────

DM: "As Zara creeps closer, her foot dislodges a loose stone. It
    clatters across the cave floor. The goblins look up, eyes widening!"

    ⚔️ ROLL INITIATIVE!

    Initiative Order:
    1. Elara (Wizard)     - 19
    2. Goblin A           - 15
    3. Zara (Rogue)       - 14
    4. Thorin (Fighter)   - 12
    5. Marcus (Cleric)    - 8
    6. Goblin B           - 6

═══════════════════════════════════════════════════════════════════════
ROUND 1
═══════════════════════════════════════════════════════════════════════

▶ ELARA'S TURN

Elara (AI): "Sleep!" *waves her hand in an arc, arcane energy swirling*

    [Casting Sleep - affects 5d8 = 22 HP of creatures]
    [Goblin A: 7 HP - ASLEEP]
    [Goblin B: 7 HP - ASLEEP (14 total, under 22)]

DM: "Both goblins slump to the ground, snoring softly. The magical
    sleep takes hold instantly."

Elara: "Zara, bind them. We may need to question them about the layout."

──────────────────────────────────────────────────────────────────────

▶ ZARA'S TURN (Goblins asleep, auto-success)

Zara (AI): *quickly ties up both goblins with rope from her pack*
    "Done. Should we wake one for questioning?"

    [Using object interaction + action to secure both goblins]

──────────────────────────────────────────────────────────────────────

▶ THORIN'S TURN

Thorin (AI): *moves up to guard the tied goblins*
    "I'll watch these wretches. If either so much as twitches wrong..."
    *taps battleaxe meaningfully*

    [Readying action: Attack if goblin tries to escape]

──────────────────────────────────────────────────────────────────────

▶ MARCUS'S TURN

Marcus (AI): *casts Light on his holy symbol, illuminating the chamber*
    "The darkness recedes before Lathander's grace. Let me examine these
    goblins for any markings or insignia."

    [Rolls Investigation: d20+2 = 14]

DM: "You notice one goblin has a crude tattoo of a fanged mouth on its
    arm - the mark of the Cragmaw tribe. This confirms what you learned
    from the captured scout."

═══════════════════════════════════════════════════════════════════════
COMBAT ENDS - INTERROGATION
═══════════════════════════════════════════════════════════════════════

Zara: *slaps one goblin awake* "Rise and shine, little friend."

DM (as Goblin): *sputters awake, eyes wide with fear*
    "No kill! No kill Yeemik! Yeemik tell everything!"

    [NPC MEMORY: Yeemik - cowardly goblin, now terrified of party]

Thorin: "Where's the dwarf prisoner? Speak true or speak with your
    ancestors."

    [Thorin rolls Intimidation: d20+1 = 18]

DM (as Yeemik): "Dwarf in big cave! With Klarg! But... but Yeemik
    help you! Yeemik hate Klarg! Klarg take best food, best shinies.
    You kill Klarg, Yeemik tell others not to fight!"

Elara: *exchanges a glance with the party*
    "Interesting. A power struggle among the goblins. We could use this."

Marcus: "Be wary. Goblins are treacherous by nature."

Zara: "True, but a distraction serves us well regardless."

    [WORLD EVENT RECORDED: Party captured goblin Yeemik, learned of
    power struggle with Klarg. Potential ally/traitor.]

DM: "What do you do with this information?"
```

### Session Summary (auto-generated at end)

```
═══════════════════════════════════════════════════════════════════════
SESSION 5 SUMMARY
═══════════════════════════════════════════════════════════════════════

KEY EVENTS:
• Party entered Goblin Caves
• Elara's Sleep spell neutralized 2 goblin guards
• Captured goblin "Yeemik" revealed power struggle with leader Klarg
• Confirmed Gundren Rockseeker is held in main cave
• Party considering using goblin politics to their advantage

CHARACTER DEVELOPMENTS:
• Thorin: Showed restraint in not killing sleeping goblins (unusual)
• Elara: Taking tactical leadership role
• Zara: Effective scout, suggested keeping Yeemik as potential asset
• Marcus: Voice of caution regarding goblin trustworthiness

UNRESOLVED:
• Rescue Gundren Rockseeker
• Deal with Klarg
• Decide Yeemik's fate
• Unknown threats deeper in cave system

NEXT SESSION HOOK:
The party stands at a crossroads - trust a treacherous goblin's offer
of assistance, or fight through the caves on their own terms.
═══════════════════════════════════════════════════════════════════════
```

---

*Document Version: 1.0*  
*Last Updated: 2026-02-05*  
*Author: Eliza Development Team*
