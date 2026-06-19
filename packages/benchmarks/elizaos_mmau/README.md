# elizaos_mmau

Legacy distribution-name shim for the MMAU audio benchmark.

The real implementation lives in [`../mmau-audio/`](../mmau-audio/) under the
`elizaos_mmau_audio` package. This shim exists so any tooling or scripts that
still invoke `python -m elizaos_mmau` continue to work without modification.

## Files

| File | Purpose |
|------|---------|
| `__init__.py` | Adds `mmau-audio/` to `sys.path` then re-exports everything from `elizaos_mmau_audio`, including `main` from its CLI module. |
| `__main__.py` | Entry point for `python -m elizaos_mmau`; delegates immediately to `main()`. |

## Usage

```bash
# legacy invocation — works identically to python -m elizaos_mmau_audio
python -m elizaos_mmau [args...]
```

For documentation on flags, evaluation datasets, and scoring, see
[`../mmau-audio/README.md`](../mmau-audio/README.md).
