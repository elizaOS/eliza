"""Safety layer tests."""

from __future__ import annotations

import unittest

from eliza_robot.bridge.safety import CommandRateLimiter


class CommandRateLimiterTests(unittest.TestCase):
    def test_rate_limit_blocks_after_threshold(self) -> None:
        limiter = CommandRateLimiter(max_commands_per_sec=2)
        result1 = limiter.check()
        result2 = limiter.check()
        result3 = limiter.check()

        self.assertTrue(result1.allowed)
        self.assertTrue(result2.allowed)
        self.assertFalse(result3.allowed)
        self.assertGreaterEqual(result3.retry_after_sec, 0.0)


if __name__ == "__main__":
    unittest.main()

