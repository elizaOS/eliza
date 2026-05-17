# CLS Alarm Notification Template Variables

## Overview

When configuring alarm notification callbacks in Tencent Cloud Log Service (CLS), you can use **Go `text/template`** syntax to dynamically render alarm data into your notification payload (e.g., DingTalk webhook body).

The following variables are injected into the template context when an alarm fires.

## Variable Reference

| Variable | Type | Description |
|----------|------|-------------|
| `.NotifyTime` | string | The time when the alarm notification was triggered. Format: `YYYY-MM-DD HH:MM:SS`. |
| `.QueryResult` | array of arrays | The alarm query results. Each element is an array of log objects returned by one query statement. If the alarm has a single query, `.QueryResult` is a 1-element array containing one sub-array. |
| `.DetailUrl` | string | URL link to the alarm detail page in the CLS console. |
| `.NotifyType` | int | Notification type. `1` = alarm triggered, `2` = alarm recovered. |
| `.AlarmName` | string | The name of the alarm policy that fired. |
| `.Condition` | string | The trigger condition expression (e.g., `"count > 0"`). |

## QueryResult Structure

`.QueryResult` is a **two-dimensional array**:

```
.QueryResult = [
  [ {log_obj_1}, {log_obj_2}, ... ],   // results from query statement #1
  [ {log_obj_A}, {log_obj_B}, ... ],   // results from query statement #2 (if any)
]
```

Each log object is a map with string keys. The available keys depend on your log fields. Common fields for POS connection alerts include:

- `sn` — Device serial number
- `shopName` — Store name
- `shopNo` — Store number
- `logTime` — Log timestamp
- `message` — Log message content

To access the results of a specific query statement, you need to extract the sub-array at the corresponding position. Refer to the Go template reference for the built-in functions available for working with arrays and slices.

## Usage Example

When building an alarm notification template, combine these variables with Go template syntax:

```
{{.AlarmName}} triggered at {{.NotifyTime}}
Details: {{.DetailUrl}}
```

For iterating over query results and rendering individual log entries, use `range` to loop through the appropriate result set.

## Notes

- `.NotifyTime` is the notification trigger time, **not** the log event time. Do not confuse it with `.logTime` inside query result objects.
- `.NotifyType` is an integer, not a string. `1` indicates the alarm was triggered; `2` indicates recovery.
- Variable names are **case-sensitive**. Incorrect casing (e.g., `.notifyTime`, `.notifytime`) will not resolve to any value.
