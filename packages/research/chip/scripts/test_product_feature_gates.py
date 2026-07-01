#!/usr/bin/env python3
"""Regression tests for scripts/check_product_feature_gates.py."""

from __future__ import annotations

import unittest

import check_product_feature_gates as gates


def assert_false_claim_flags(testcase: unittest.TestCase, report: dict[str, object]) -> None:
    testcase.assertEqual(report["claim_boundary"], gates.CLAIM_BOUNDARY)
    for key, expected in gates.FALSE_CLAIM_FLAGS.items():
        testcase.assertIs(report.get(key), expected, key)


class ProductFeatureGatesReportTests(unittest.TestCase):
    def test_pass_report_denies_runtime_release_and_compliance_claims(self) -> None:
        report = gates.report_payload([])
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["summary"]["findings"], 0)
        assert_false_claim_flags(self, report)

    def test_fail_report_denies_runtime_release_and_compliance_claims(self) -> None:
        report = gates.report_payload(["CTS passed claim must remain forbidden"])
        self.assertEqual(report["status"], "fail")
        self.assertEqual(report["summary"]["findings"], 1)
        self.assertEqual(report["findings"][0]["severity"], "fail")
        assert_false_claim_flags(self, report)


if __name__ == "__main__":
    unittest.main()
