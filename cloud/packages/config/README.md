# Config

Static configuration files used at runtime. Prefer config here over env for structured or multi-value settings so changes are versioned and reviewable.

**Signup codes** are not in this directory; they are loaded from the `SIGNUP_CODES_JSON` env var (JSON object). If unset, defaults to `{}`. See [docs/signup-codes.md](../docs/signup-codes.md) for schema, API, and WHYs.
