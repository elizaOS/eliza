# Canonical DSL v1.1 Specification

**Version:** 1.1  
**Status:** Active  
**Last Updated:** 2024-03-10

---

## 1. Overview

The Canonical DSL v1.1 defines a JSON-based representation for Scratch project scripts. It provides a standardized, machine-readable format for describing sprite behaviors, event handlers, and control flow logic. This specification is the **authoritative reference** for all DSL generation and validation tooling.

---

## 2. Top-Level Structure

A valid Canonical DSL v1.1 document MUST have the following top-level structure:

```json
{
  "scripts": [
    { ... },
    { ... }
  ]
}
```

The root object contains exactly one key: `"scripts"`, whose value is an array of **script objects**. Scripts are organized per-sprite at a higher level (project metadata), not within the DSL document itself.

---

## 3. Script Object

Each script object represents a single event-driven script (a "stack" in Scratch terminology). Every script object MUST contain the following three fields:

| Field    | Type     | Required | Description |
|----------|----------|----------|-------------|
| `hat`    | string   | YES      | The opcode of the hat (event) block that triggers this script |
| `hatId`  | string   | YES      | A unique string identifier for this script (e.g., `"hat_player_flag_1"`) |
| `blocks` | array    | YES      | Ordered array of block objects executed when the hat triggers |

### 3.1 Hat Block Opcodes

The `hat` field must be one of the following valid hat opcodes:

| Opcode | Description | Additional Fields |
|--------|-------------|-------------------|
| `event_whenflagclicked` | Triggered when the green flag is clicked | None |
| `control_start_as_clone` | Triggered when a clone starts | None |
| `event_whenbroadcastreceived` | Triggered when a specific broadcast is received | Requires `hatFields: {"BROADCAST_OPTION": "<name>"}` |
| `event_whenkeypressed` | Triggered when a specific key is pressed | Requires `hatFields: {"KEY_OPTION": "<key>"}` |

### 3.2 hatId Requirements

- Must be a non-empty string
- Must be unique across all scripts in the document
- Recommended format: `hat_<sprite>_<purpose>_<number>` (e.g., `"hat_enemy_clone_1"`)

### Example Script Object

```json
{
  "hat": "event_whenflagclicked",
  "hatId": "hat_player_init_1",
  "blocks": [
    {
      "opcode": "data_setvariableto",
      "inputs": { "VALUE": 0 },
      "fields": { "VARIABLE": "score" }
    }
  ]
}
```

---

## 4. Block Object

Each block object within the `blocks` array represents a single Scratch block. A block object has the following structure:

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `opcode` | string | YES      | The Scratch opcode identifying the block type |
| `inputs` | object | NO*      | Key-value pairs for the block's input slots |
| `fields` | object | NO*      | Key-value pairs for the block's dropdown/field selections |

*Some blocks require inputs and/or fields; see the opcode reference below.

### 4.1 Input Values

Input values can be:
- **Literal values**: strings, numbers, booleans (e.g., `"VALUE": 10`)
- **Nested block objects**: another block object used as a reporter (e.g., an `operator_random` block)
- **Arrays of block objects**: used for substacks (e.g., the body of a loop)

---

## 5. Opcode Reference

### 5.1 Data Blocks

#### `data_setvariableto`
Sets a variable to a specific value.
- **inputs:** `VALUE` — the value to set (literal or reporter block)
- **fields:** `VARIABLE` — the variable name (string)

```json
{
  "opcode": "data_setvariableto",
  "inputs": { "VALUE": 0 },
  "fields": { "VARIABLE": "分数" }
}
```

#### `data_changevariableby`
Changes a variable by a given amount.
- **inputs:** `VALUE` — the amount to change by (literal or reporter block)
- **fields:** `VARIABLE` — the variable name (string)

```json
{
  "opcode": "data_changevariableby",
  "inputs": { "VALUE": -1 },
  "fields": { "VARIABLE": "生命" }
}
```

### 5.2 Control Blocks

#### `control_wait`
Pauses execution for a specified duration.
- **inputs:** `DURATION` — seconds to wait (number or reporter)

```json
{
  "opcode": "control_wait",
  "inputs": { "DURATION": 1 }
}
```

#### `control_forever`
Repeats the enclosed blocks indefinitely.
- **inputs:** `SUBSTACK` — array of block objects to repeat

```json
{
  "opcode": "control_forever",
  "inputs": {
    "SUBSTACK": [
      { "opcode": "motion_changeyby", "inputs": { "DY": -5 } }
    ]
  }
}
```

#### `control_if`
Conditional execution (if-then).
- **inputs:**
  - `CONDITION` — a boolean reporter block object
  - `SUBSTACK` — array of block objects to execute if condition is true

```json
{
  "opcode": "control_if",
  "inputs": {
    "CONDITION": {
      "opcode": "operator_gt",
      "inputs": { "OPERAND1": "score", "OPERAND2": 10 }
    },
    "SUBSTACK": [
      { "opcode": "data_setvariableto", "inputs": { "VALUE": "hard" }, "fields": { "VARIABLE": "difficulty" } }
    ]
  }
}
```

#### `control_repeat_until`
Repeats the enclosed blocks until a condition becomes true.
- **inputs:**
  - `CONDITION` — a boolean reporter block object
  - `SUBSTACK` — array of block objects to repeat

#### `control_create_clone_of`
Creates a clone of a specified sprite.
- **inputs:** `CLONE_OPTION` — sprite name string (e.g., `"_myself_"`, `"Enemy"`)

```json
{
  "opcode": "control_create_clone_of",
  "inputs": { "CLONE_OPTION": "_myself_" }
}
```

#### `control_delete_this_clone`
Deletes the current clone. No inputs or fields required.

```json
{
  "opcode": "control_delete_this_clone"
}
```

### 5.3 Operator Blocks

#### `operator_random`
Returns a random number between FROM and TO (inclusive).
- **inputs:** `FROM` — lower bound, `TO` — upper bound

```json
{
  "opcode": "operator_random",
  "inputs": { "FROM": -220, "TO": 220 }
}
```

#### `operator_equals`
Returns true if two values are equal.
- **inputs:** `OPERAND1`, `OPERAND2`

#### `operator_gt`
Returns true if OPERAND1 is greater than OPERAND2.
- **inputs:** `OPERAND1`, `OPERAND2`

### 5.4 Motion Blocks

#### `motion_gotoxy`
Moves the sprite to an absolute (x, y) position.
- **inputs:** `X` — x coordinate, `Y` — y coordinate

```json
{
  "opcode": "motion_gotoxy",
  "inputs": {
    "X": { "opcode": "operator_random", "inputs": { "FROM": -220, "TO": 220 } },
    "Y": 170
  }
}
```

#### `motion_changeyby`
Changes the sprite's Y position by a given amount.
- **inputs:** `DY` — amount to change Y by

#### `motion_setx`
Sets the sprite's X position to a specific value.
- **inputs:** `X` — the x coordinate

### 5.5 Sensing Blocks

#### `sensing_touchingobject`
Returns true if the sprite is touching a specified object.
- **inputs:** `TOUCHINGOBJECTMENU` — the object name (e.g., `"_edge_"`, `"Player"`, `"_mouse_"`)

```json
{
  "opcode": "sensing_touchingobject",
  "inputs": { "TOUCHINGOBJECTMENU": "_edge_" }
}
```

### 5.6 Looks Blocks

#### `looks_show`
Makes the sprite visible. No inputs or fields.

#### `looks_hide`
Makes the sprite invisible. No inputs or fields.

### 5.7 Event Blocks

#### `event_broadcast`
Sends a broadcast message.
- **inputs:** `BROADCAST_INPUT` — the broadcast message name (string)

```json
{
  "opcode": "event_broadcast",
  "inputs": { "BROADCAST_INPUT": "game_over" }
}
```

---

## 6. Validation Rules

1. The top-level object MUST contain exactly `{"scripts": [...]}`.
2. Every script MUST have `hat`, `hatId`, and `blocks` fields.
3. All `hatId` values MUST be unique within the document.
4. Opcodes MUST use the exact lowercase-with-underscore format specified above.
5. Required inputs/fields for each opcode MUST be present.
6. `SUBSTACK` values MUST be arrays of block objects.
7. `CONDITION` values MUST be boolean reporter block objects.
8. Variable names should match the project metadata exactly (including Unicode characters).

---

## 7. Encoding

- The DSL document MUST be valid JSON encoded in UTF-8.
- Variable names, broadcast names, and other user-defined strings may contain Unicode characters (e.g., Chinese characters like `"分数"`, `"生命"`).
- String values should not be HTML-encoded or escaped beyond standard JSON escaping.

---

*End of Canonical DSL v1.1 Specification*
