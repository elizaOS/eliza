# Scratch Opcode Reference for DSL Generation

**Version:** Aligned with Canonical DSL v1.1  
**Last Updated:** 2024-03-10

This document provides a quick-reference table of all Scratch opcodes supported by the Canonical DSL, along with their required inputs and fields.

---

## Hat Blocks (Script Triggers)

Hat blocks are used in the `hat` field of a script object. They are NOT placed in the `blocks` array.

| Opcode | Description | Hat Fields |
|--------|-------------|------------|
| `event_whenflagclicked` | When green flag clicked | None |
| `control_start_as_clone` | When I start as a clone | None |
| `event_whenbroadcastreceived` | When I receive broadcast | `BROADCAST_OPTION`: broadcast name |
| `event_whenkeypressed` | When key pressed | `KEY_OPTION`: key name |

---

## Stack Blocks (Actions)

These blocks go in the `blocks` array and execute sequentially.

### Data Blocks

| Opcode | Inputs | Fields | Description |
|--------|--------|--------|-------------|
| `data_setvariableto` | `VALUE`: any | `VARIABLE`: variable name | Set variable to value |
| `data_changevariableby` | `VALUE`: number | `VARIABLE`: variable name | Change variable by amount |

### Control Blocks

| Opcode | Inputs | Fields | Description |
|--------|--------|--------|-------------|
| `control_wait` | `DURATION`: number (seconds) | — | Wait for duration |
| `control_forever` | `SUBSTACK`: block array | — | Repeat forever |
| `control_if` | `CONDITION`: boolean block, `SUBSTACK`: block array | — | If-then |
| `control_if_else` | `CONDITION`: boolean block, `SUBSTACK`: block array, `SUBSTACK2`: block array | — | If-then-else |
| `control_repeat_until` | `CONDITION`: boolean block, `SUBSTACK`: block array | — | Repeat until condition is true |
| `control_create_clone_of` | `CLONE_OPTION`: sprite name or `"_myself_"` | — | Create clone of sprite |
| `control_delete_this_clone` | — | — | Delete this clone |

### Motion Blocks

| Opcode | Inputs | Fields | Description |
|--------|--------|--------|-------------|
| `motion_gotoxy` | `X`: number, `Y`: number | — | Go to x, y position |
| `motion_changeyby` | `DY`: number | — | Change y by amount |
| `motion_setx` | `X`: number | — | Set x to value |
| `motion_sety` | `Y`: number | — | Set y to value |
| `motion_changexby` | `DX`: number | — | Change x by amount |

### Looks Blocks

| Opcode | Inputs | Fields | Description |
|--------|--------|--------|-------------|
| `looks_show` | — | — | Show sprite |
| `looks_hide` | — | — | Hide sprite |
| `looks_sayforsecs` | `MESSAGE`: string, `SECS`: number | — | Say message for seconds |

### Event Blocks

| Opcode | Inputs | Fields | Description |
|--------|--------|--------|-------------|
| `event_broadcast` | `BROADCAST_INPUT`: broadcast name | — | Send broadcast |
| `event_broadcastandwait` | `BROADCAST_INPUT`: broadcast name | — | Send broadcast and wait |

---

## Reporter Blocks (Values)

Reporter blocks are used as input values within other blocks. They are nested as objects in the `inputs` of their parent block.

### Operator Reporters

| Opcode | Inputs | Returns | Description |
|--------|--------|---------|-------------|
| `operator_random` | `FROM`: number, `TO`: number | number | Random number between FROM and TO |
| `operator_add` | `NUM1`: number, `NUM2`: number | number | Addition |
| `operator_subtract` | `NUM1`: number, `NUM2`: number | number | Subtraction |
| `operator_multiply` | `NUM1`: number, `NUM2`: number | number | Multiplication |

### Boolean Reporters

| Opcode | Inputs | Returns | Description |
|--------|--------|---------|-------------|
| `operator_equals` | `OPERAND1`: any, `OPERAND2`: any | boolean | Equality check |
| `operator_gt` | `OPERAND1`: number, `OPERAND2`: number | boolean | Greater than |
| `operator_lt` | `OPERAND1`: number, `OPERAND2`: number | boolean | Less than |
| `operator_and` | `OPERAND1`: boolean, `OPERAND2`: boolean | boolean | Logical AND |
| `operator_or` | `OPERAND1`: boolean, `OPERAND2`: boolean | boolean | Logical OR |
| `operator_not` | `OPERAND`: boolean | boolean | Logical NOT |

### Sensing Reporters

| Opcode | Inputs | Returns | Description |
|--------|--------|---------|-------------|
| `sensing_touchingobject` | `TOUCHINGOBJECTMENU`: object name | boolean | Is touching object? |

**Special object names for `TOUCHINGOBJECTMENU`:**
- `"_edge_"` — the stage edge
- `"_mouse_"` — the mouse pointer
- Any sprite name (e.g., `"Player"`, `"Enemy"`)

### Data Reporters

| Opcode | Inputs | Fields | Returns | Description |
|--------|--------|--------|---------|-------------|
| `data_variable` | — | `VARIABLE`: variable name | any | Get variable value |

---

## Nesting Example

Reporters can be nested inside inputs of other blocks:

```json
{
  "opcode": "motion_gotoxy",
  "inputs": {
    "X": {
      "opcode": "operator_random",
      "inputs": { "FROM": -220, "TO": 220 }
    },
    "Y": 170
  }
}
```

Boolean reporters are used in CONDITION inputs:

```json
{
  "opcode": "control_if",
  "inputs": {
    "CONDITION": {
      "opcode": "operator_gt",
      "inputs": { "OPERAND1": 10, "OPERAND2": 5 }
    },
    "SUBSTACK": [ ... ]
  }
}
```

---

*End of Opcode Reference*
