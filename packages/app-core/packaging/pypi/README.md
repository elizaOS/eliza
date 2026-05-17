# elizaos-app

Python launcher for the elizaOS App.

This package provides the `elizaos-app` command for environments that install
applications through PyPI. The launcher validates that Node.js is available,
then delegates to the version-matched npm `elizaos` command.

```bash
pip install elizaos-app
elizaos-app --help
```

Node.js 22 or newer must be available on `PATH`.
