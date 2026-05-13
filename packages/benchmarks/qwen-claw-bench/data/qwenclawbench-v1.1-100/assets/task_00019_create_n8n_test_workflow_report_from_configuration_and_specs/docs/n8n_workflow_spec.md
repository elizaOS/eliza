# Test Workflow Specification

**Document Version:** 2.1  
**Last Updated:** 2024-05-28  
**Author:** Platform Engineering Team  
**Status:** Approved

---

## 1. Overview

This document defines the required structure and conventions for all test workflows created within the n8n automation platform. All teams must follow these specifications when building test or validation workflows.

## 2. Required Workflow Structure

All test workflows **must** include the following three nodes in order:

### 2.1 Manual Trigger Node (Entry Point)

- Every test workflow must begin with a **Manual Trigger** node.
- This node serves as the entry point and allows manual execution during testing and validation.
- No additional parameters are required for this node.
- The node type in the workflow JSON must be the current n8n type identifier (refer to the node reference documentation).

### 2.2 Set Node (Test Variable Definition)

- The second node must be a **Set** node that defines the following test variables:
  - `testName` — A descriptive string identifying the test (e.g., `"Integration_Smoke_Test"`)
  - `testTimestamp` — An ISO 8601 timestamp indicating when the test was initiated (e.g., `"2024-06-15T10:00:00Z"`)
- The Set node must use the `assignments` array format for defining field name/value pairs.
- Additional test variables may be added as needed, but `testName` and `testTimestamp` are mandatory.

### 2.3 Function Node (Processing and Validation)

- The third node must be a **Function** node that:
  - Reads the variables set by the Set node
  - Performs any necessary processing or transformation
  - Validates that the required fields are present and correctly formatted
  - Returns a result object with at minimum: `{ status: "pass" | "fail", message: string }`
- The `functionCode` parameter must contain valid JavaScript.

## 3. Naming Convention

Workflow names **must** follow this pattern:

```
Test_Workflow_<purpose>
```

Where `<purpose>` is a concise, PascalCase description of the test's objective. Examples:
- `Test_Workflow_SmtpValidation`
- `Test_Workflow_DatabaseConnectivity`
- `Test_Workflow_ApiHealthCheck`

## 4. Storage and Deployment

- All test workflows must be saved to the directory defined in the `workflowsDir` field of the `n8n_server.json` configuration file.
- Do **not** hardcode paths. Always reference the server configuration for the correct storage location.
- Workflow files should be named using the workflow name with a `.json` extension (e.g., `Test_Workflow_SmtpValidation.json`).

## 5. Output Format

The workflow JSON must be **n8n-compatible** and include the following top-level fields:

| Field         | Type   | Description                                      |
|---------------|--------|--------------------------------------------------|
| `name`        | string | Workflow name following the naming convention     |
| `nodes`       | array  | Array of node objects with type, parameters, etc. |
| `connections`  | object | Defines how nodes are connected to each other     |
| `settings`    | object | Workflow-level settings (e.g., timezone)          |

### 5.1 Node Object Structure

Each node in the `nodes` array must have:
- `name` — Display name of the node
- `type` — The n8n node type identifier string
- `typeVersion` — Version of the node type (use latest stable)
- `position` — `[x, y]` coordinates for canvas placement
- `parameters` — Object containing node-specific configuration

### 5.2 Connections Object Structure

The `connections` object maps source node names to their output connections:

```json
{
  "connections": {
    "Source Node Name": {
      "main": [
        [
          {
            "node": "Target Node Name",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}
```

## 6. Validation Checklist

Before submitting a test workflow, verify:

- [ ] Workflow starts with a Manual Trigger node
- [ ] Set node defines `testName` and `testTimestamp`
- [ ] Function node includes validation logic
- [ ] Workflow name matches `Test_Workflow_<purpose>` pattern
- [ ] JSON includes `nodes`, `connections`, and `settings` fields
- [ ] Workflow is saved to the correct `workflowsDir` path from server config

---

*For node type identifiers and parameter formats, refer to `n8n_node_reference.md`.*
