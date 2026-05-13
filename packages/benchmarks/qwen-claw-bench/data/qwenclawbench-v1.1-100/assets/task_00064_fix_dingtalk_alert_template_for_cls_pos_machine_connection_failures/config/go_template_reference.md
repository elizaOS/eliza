# Go `text/template` Quick Reference

## Overview

This document covers Go template syntax commonly used in CLS alarm notification templates. CLS uses the standard Go `text/template` package to render alarm data into notification payloads.

## Basic Syntax

All template actions are enclosed in double curly braces: `{{ }}`.

### Printing a Variable

```
{{.FieldName}}
```

Outputs the value of `FieldName` from the current context.

---

## Range (Iteration)

### Iterating Over a Slice

```
{{range .Items}}
  Item: {{.Name}}
{{end}}
```

### Iterating With Index

```
{{range $index, $element := .Items}}
  #{{$index}}: {{$element.Name}}
{{end}}
```

---

## Accessing Array Elements by Index

Use the `index` built-in function to access specific elements of an array or slice:

```
{{index .MyArray 0}}
```

---

## Conditional Logic

### Simple If

```
{{if .FieldName}}
  FieldName is non-empty/non-zero
{{end}}
```

### If-Else

```
{{if .FieldName}}
  present
{{else}}
  absent
{{end}}
```

### Or / And Conditions

```
{{if or .FieldA .FieldB}}
  At least one is truthy
{{end}}

{{if and .FieldA .FieldB}}
  Both are truthy
{{end}}
```

### Equality Check

```
{{if eq .Status 1}}active{{else}}inactive{{end}}
```

---

## Whitespace Trimming

By default, text outside `{{ }}` actions (including newlines and spaces) is preserved verbatim. Use the dash (`-`) modifier to trim adjacent whitespace:

| Syntax | Effect |
|--------|--------|
| `{{- .X}}` | Trims whitespace **before** the action |
| `{{.X -}}` | Trims whitespace **after** the action |
| `{{- .X -}}` | Trims whitespace on **both** sides |

### Example

```
Items:{{range .List}}
  - {{.Name}}
{{end}}Done
```

Output (with extra blank lines):
```
Items:
  - Apple
  - Banana

Done
```

With trimming:
```
Items:{{range .List}}
  - {{.Name}}
{{- end}}
Done
```

Output (no trailing blank line):
```
Items:
  - Apple
  - Banana
Done
```

---

## Embedding Templates in JSON Strings

When the rendered template output is embedded inside a JSON string value (e.g., DingTalk `text.content`), you must ensure:

1. **No raw double quotes** in template output — they will break the JSON structure. Use single quotes or escape them.
2. **No literal newlines** in the output — JSON string values cannot contain raw newline characters. Use `\n` (the two-character escape sequence) instead.
3. **No unescaped backslashes** — if your template needs to output a literal backslash, use `\\`.

### Strategy

The safest approach is to write the entire `content` value on a single line in the JSON, using `\n` for line breaks, and ensure the Go template actions do not introduce raw newlines or double quotes.

### Example (Single-Line JSON Content)

```json
{"msgtype":"text","text":{"content":"Name: {{.AlarmName}}\nTime: {{.NotifyTime}}\n{{range .Items}}{{.Label}}: {{.Value}}\n{{end}}"}}
```

---

## Built-in Functions

| Function | Usage | Description |
|----------|-------|-------------|
| `index` | `{{index .Arr 0}}` | Access element at index |
| `len` | `{{len .Arr}}` | Length of array/slice/map |
| `eq` | `{{eq .A .B}}` | Equality comparison |
| `ne` | `{{ne .A .B}}` | Not-equal comparison |
| `lt`, `le`, `gt`, `ge` | `{{gt .X 5}}` | Numeric comparisons |
| `or` | `{{or .A .B}}` | Logical OR |
| `and` | `{{and .A .B}}` | Logical AND |
| `not` | `{{not .A}}` | Logical NOT |
| `printf` | `{{printf "%.2f" .Val}}` | Formatted output |

**Note:** Built-in functions can be composed with other template actions wherever a value expression is accepted. Block actions (`range`, `with`, `if`) establish their own evaluation context within their body — refer to the official Go `text/template` documentation for details on context binding semantics. The `$` variable is available in all contexts and refers to the original top-level data passed to the template.
