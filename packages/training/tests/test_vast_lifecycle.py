import subprocess
from unittest.mock import patch

import pytest

from eliza_training.lib.vast import is_alive


def test_failed_status_request_does_not_authorize_duplicate_rental():
    with patch('eliza_training.lib.vast.show_instance', side_effect=subprocess.CalledProcessError(1, ['vastai'])):
        with pytest.raises(subprocess.CalledProcessError):
            is_alive(123)


@pytest.mark.parametrize('status,expected', [('running', True), ('loading', True), ('destroyed', False), ('stopped', False)])
def test_liveness_uses_confirmed_status(status, expected):
    with patch('eliza_training.lib.vast.show_instance', return_value={'actual_status': status}):
        assert is_alive(123) is expected
