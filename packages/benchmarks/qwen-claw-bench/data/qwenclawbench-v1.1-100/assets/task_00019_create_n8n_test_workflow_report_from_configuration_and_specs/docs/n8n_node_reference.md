# n8n Node Type Reference

**Document Version:** 3.0  
**Last Updated:** 2024-04-12  
**Applicable n8n Version:** 1.50.0+  
**Author:** Platform Engineering Team

---

## Overview

This reference lists the valid n8n node types and their required parameters for use in workflow JSON definitions. Always use the exact `type` string shown below when constructing workflow files programmatically.

> **Important:** Node type identifiers changed in n8n v1.0+. Legacy identifiers (e.g., `n8n-nodes-base.start`) are **deprecated** and must not be used. See the [Migration Notes](#migration-notes) section at the bottom.

---

## Manual Trigger

Starts a workflow manually via the n8n UI or API.

| Property       | Value                              |
|----------------|------------------------------------|
| **Type**       | `n8n-nodes-base.manualTrigger`     |
| **typeVersion**| `1`                                |
| **Parameters** | *(none required)*                  |

### Example Node JSON

```json
{
  "name": "Manual Trigger",
  "type": "n8n-nodes-base.manualTrigger",
  "typeVersion": 1,
  "position": [250, 300],
  "parameters": {}
}
```

---

## Set

Sets or overrides field values on the input data items. Used to define variables, constants, or transform data fields.

| Property       | Value                              |
|----------------|------------------------------------|
| **Type**       | `n8n-nodes-base.set`               |
| **typeVersion**| `3.4`                              |
| **Parameters** | `assignments` (array of objects)   |

### Parameters Detail

The `assignments` field is an array where each entry defines a field to set:

```json
{
  "assignments": {
    "assignments": [
      {
        "id": "unique-id-1",
        "name": "fieldName",
        "value": "fieldValue",
        "type": "string"
      }
    ]
  }
}
```

Supported types: `string`, `number`, `boolean`.

### Example Node JSON

```json
{
  "name": "Set Variables",
  "type": "n8n-nodes-base.set",
  "typeVersion": 3.4,
  "position": [480, 300],
  "parameters": {
    "assignments": {
      "assignments": [
        {
          "id": "a1b2c3",
          "name": "testName",
          "value": "SampleTest",
          "type": "string"
        },
        {
          "id": "d4e5f6",
          "name": "testTimestamp",
          "value": "2024-06-15T10:00:00Z",
          "type": "string"
        }
      ]
    }
  }
}
```

> **Note:** Older versions of n8n used `parameters.values` instead of `parameters.assignments`. The `values` format is deprecated as of n8n v1.0 and will not work in current versions.

---

## Function

Executes custom JavaScript code to process, transform, or validate data.

| Property       | Value                              |
|----------------|------------------------------------|
| **Type**       | `n8n-nodes-base.function`          |
| **typeVersion**| `1`                                |
| **Parameters** | `functionCode` (string)            |

### Parameters Detail

- `functionCode` — A string containing valid JavaScript. The code has access to `items` (input data array) and must return an array of items.

### Example Node JSON

```json
{
  "name": "Process Data",
  "type": "n8n-nodes-base.function",
  "typeVersion": 1,
  "position": [710, 300],
  "parameters": {
    "functionCode": "const results = [];\nfor (const item of items) {\n  results.push({ json: { status: 'pass', message: 'Validation successful' } });\n}\nreturn results;"
  }
}
```

---

## HTTP Request

Makes HTTP requests to external APIs or services.

| Property       | Value                              |
|----------------|------------------------------------|
| **Type**       | `n8n-nodes-base.httpRequest`       |
| **typeVersion**| `4.2`                              |
| **Parameters** | `url` (string), `method` (string)  |

### Parameters Detail

- `url` — The full URL to send the request to.
- `method` — HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`.
- Optional: `headers`, `queryParameters`, `body`, `authentication`.

### Example Node JSON

```json
{
  "name": "HTTP Request",
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.2,
  "position": [940, 300],
  "parameters": {
    "url": "https://api.example.com/health",
    "method": "GET"
  }
}
```

---

## Migration Notes

The following node types are **deprecated** and must not be used in new workflows:

| Deprecated Type              | Replacement                          | Deprecated Since |
|------------------------------|--------------------------------------|------------------|
| `n8n-nodes-base.start`      | `n8n-nodes-base.manualTrigger`       | v1.0 (2023-07)   |
| `n8n-nodes-base.function`   | *(still supported, see note below)*  | —                |

> **Note on Function node:** While `n8n-nodes-base.function` remains supported, n8n v1.30+ also introduced `n8n-nodes-base.code` as an alternative with enhanced features. Both are valid for current use. The `function` type is recommended for simple validation tasks.

### Parameter Format Changes (v1.0+)

| Node    | Old Format (Deprecated)       | New Format (Current)          |
|---------|-------------------------------|-------------------------------|
| Set     | `parameters.values`           | `parameters.assignments`      |

---

*For workflow structure requirements, refer to `n8n_workflow_spec.md`.*
