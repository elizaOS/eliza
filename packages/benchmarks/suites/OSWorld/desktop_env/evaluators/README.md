# OSWorld evaluators

Python evaluators inspect application state and files produced by desktop tasks.
Install the OSWorld dependencies and the applications required by the selected
benchmark tasks inside the controlled VM; document/image checks also use
python-pptx, python-docx, odfpy, OpenCV, Pillow, and imagehash.

No separate build is required. From `packages/benchmarks/suites/OSWorld`, run:

```bash
python -m pytest tests
```

These tests cover the local adapter; real desktop evaluation additionally needs
the configured VM and applications. See the [suite README](../../README.md).
