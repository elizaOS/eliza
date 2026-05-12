"""Synthetic trajectory generation for Eliza-1 training.

Submodules:

- ``project_simulator``: multi-turn project simulator. A project is an
  LLM-authored multi-step goal. Each turn records (input, output) as a
  trajectory chain via parent-step linkage.
- ``drive_eliza`` / ``together_synth`` / ``build_scenarios`` /
  ``judge_filter`` (top-level scripts): one-shot scenario→trajectory
  drivers, scenario builders, and pre-training quality filters.
"""
