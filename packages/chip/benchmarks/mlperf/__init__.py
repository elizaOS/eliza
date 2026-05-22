"""E1 NPU MLPerf Inference harness (modeled, pre-silicon).

LoadGen-style scheduler + SUT over the real E1 NPU runtime/sim path.
This is a modeled, pre-silicon harness: it produces functional accuracy,
latency, throughput, and a Timeloop/Accelergy-or-scale-model-derived
``energy_joules_per_inference``. It is NOT an official MLCommons
submission and it does NOT measure silicon power.
"""
