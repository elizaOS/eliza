# Canonical DSL v1.0 Specification

**Version:** 1.0  
**Status:** Released  
**Date:** 2023-11-15  
**Author:** Scratch DSL Working Group

---

## 1. Overview

The Canonical DSL v1.0 provides a JSON-based intermediate representation for Scratch project scripts. This specification defines the schema for encoding sprite behaviors, event handling, and control flow in a portable, machine-readable format.

This document serves as the definitive reference for implementing DSL generators and validators conforming to the v1.0 standard.

---

## 2. Top-Level Structure

A valid Canonical DSL v1.0 document uses a target-based hierarchy that mirrors the Scratch project file format:

```json
{
  "targets": [
    {
      "name": "Stage",
      "isStage": true,
      "scripts": [ ... ]
    },
    {
      "name": "Player",
      "isStage": false,
      "scripts": [ ... ]
    }
  ]
}
```

The root object contains a `"targets"` array. Each target object represents a sprite or the stage and contains:

| Field     | Type    | Required | Description |
|-----------|---------|----------|-------------|
| `name`    | string  | YES      | The sprite/stage name |
| `isStage` | boolean | YES      | Whether this target is the stage |
| `scripts` | array   | YES      | Array of script objects for this target |

> **Note:** Scripts are organized within their parent target, providing clear sprite-to-script association within the DSL document itself.

---

## 3. Script Object

Each script object represents a single hat-triggered script. A script object contains:

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `hat`    | string | YES      | The opcode of the hat block |
| `blocks` | array  | YES      | Ordered array of block objects |

### 3.1 Hat Block Opcodes

| Opcode | Description |
|--------|-------------|
| `event_whenflagclicked` | Green flag clicked |
| `control_start_as_clone` | When clone starts |
| `event_whenbroadcastreceived` | When broadcast received |

### Example Script

```json
{
  "hat": "event_whenflagclicked",
  "blocks": [
    {
      "opcode": "data_setVariable",
      "inputs": { "VALUE": 0 },
      "fields": { "VARIABLE": "score" }
    }
  ]
}
```

---

## 4. Block Object

Each block in the `blocks` array has:

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `opcode` | string | YES      | The Scratch block opcode |
| `inputs` | object | NO       | Input slot values |
| `fields` | object | NO       | Dropdown/field values |

---

## 5. Core Opcodes

### 5.1 Data Blocks

#### `data_setVariable`
Sets a variable to a value.
- **inputs:** `VALUE`
- **fields:** `VARIABLE`

#### `data_changeVariable`
Changes a variable by an amount.
- **inputs:** `VALUE`
- **fields:** `VARIABLE`

### 5.2 Control Blocks

#### `control_wait`
- **inputs:** `DURATION`

#### `control_forever`
- **inputs:** `SUBSTACK` (array of blocks)

#### `control_if`
- **inputs:** `CONDITION` (boolean reporter), `SUBSTACK` (array of blocks)

#### `control_create_clone_of`
- **inputs:** `CLONE_OPTION`

#### `control_delete_this_clone`
No inputs required.

### 5.3 Operators

#### `operator_random`
- **inputs:** `FROM`, `TO`

#### `operator_equals`
- **inputs:** `OPERAND1`, `OPERAND2`

#### `operator_gt`
- **inputs:** `OPERAND1`, `OPERAND2`

### 5.4 Motion

#### `motion_gotoxy`
- **inputs:** `X`, `Y`

#### `motion_changeyby`
- **inputs:** `DY`

### 5.5 Sensing

#### `sensing_touchingobject`
- **inputs:** `TOUCHINGOBJECTMENU`

### 5.6 Looks

#### `looks_show` / `looks_hide`
No inputs required.

---

## 6. Complete Example

```json
{
  "targets": [
    {
      "name": "Player",
      "isStage": false,
      "scripts": [
        {
          "hat": "event_whenflagclicked",
          "blocks": [
            {
              "opcode": "data_setVariable",
              "inputs": { "VALUE": 0 },
              "fields": { "VARIABLE": "score" }
            },
            {
              "opcode": "control_forever",
              "inputs": {
                "SUBSTACK": [
                  {
                    "opcode": "motion_changeyby",
                    "inputs": { "DY": -2 }
                  }
                ]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 7. Validation

1. Root object MUST contain `"targets"` array.
2. Each target MUST have `name`, `isStage`, and `scripts`.
3. Each script MUST have `hat` and `blocks`.
4. Opcodes must match the reference table above.
5. Required inputs/fields must be present for each opcode.

---

*End of Canonical DSL v1.0 Specification*
