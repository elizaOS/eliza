# @openclawd/hedge

Hedge persona set for OpenClawd agents.

## Local Personas

- `activistpinch.json`
- `latticeclaw.json`
- `moatmaw.json`
- `soltoshi.json`
- `valueclaw.json`

`index.json` lists only persona definitions shipped in this directory, so the
bundle remains self-contained and every manifest reference can be resolved from
a checkout or package archive.

## Validate

```bash
npm run validate
```

The validator checks that each manifest reference stays inside the bundle,
exists, is unique, and contains valid JSON with a named persona.
