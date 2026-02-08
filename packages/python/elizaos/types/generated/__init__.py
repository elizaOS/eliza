"""Generated protobuf modules for elizaOS types.

This __init__.py adds the 'generated' directory to sys.path so that
protobuf-generated files can resolve ``from eliza.v1 import …`` imports.
"""

import os
import sys

_generated_dir = os.path.dirname(os.path.abspath(__file__))
if _generated_dir not in sys.path:
    sys.path.insert(0, _generated_dir)
