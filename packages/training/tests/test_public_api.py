"""Public domains must stay importable without accelerator dependencies."""
import subprocess
import sys


def test_domain_imports_do_not_eagerly_load_torch():
    result = subprocess.run([sys.executable, '-I', '-c', '''
import sys
import eliza_training
import eliza_training.rl
import eliza_training.training
import eliza_training.quantization
import eliza_training.publish
from eliza_training.training import REGISTRY as models, get
from eliza_training.quantization import PROFILES, QuantProfile
assert models and get("gemma4-e2b")
assert isinstance(PROFILES["Q4_K_M"], QuantProfile)
from eliza_training.release import apply_gates
from eliza_training.lib.adapters import REGISTRY
assert REGISTRY
assert 'torch' not in sys.modules
'''], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr


def test_publisher_domain_resolves_shared_context_without_preloading_cli():
    result = subprocess.run([sys.executable, '-I', '-c', '''
import sys
from eliza_training.publish import PublishContext, OrchestratorError, EXIT_OK
assert EXIT_OK == 0
assert PublishContext.__dataclass_fields__
assert issubclass(OrchestratorError, Exception)
assert 'eliza_training.publish.orchestrator' not in sys.modules
'''], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
