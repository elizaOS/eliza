"""
E2E Tests for Training Pipeline

These tests validate the complete training pipeline from trajectory generation
to scoring, ensuring all components work together correctly.

Test modules:
- test_full_pipeline: Complete pipeline tests (JSON -> scoring -> GRPO)

These tests do NOT require GPU infrastructure - they test the data pipeline
using fixtures and mocked inference. For full GPU training tests, see Tier 4
in TESTING.md.
"""
