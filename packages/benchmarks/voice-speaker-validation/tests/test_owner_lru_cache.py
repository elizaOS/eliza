"""
test_owner_lru_cache.py — Hot profiles match in < 50 ms.

Spec (W3-6 scope):
  - Owner (hot) profile lookup must complete in < 50 ms wall time.
  - This validates the LRU cache keeps the hot profiles in memory, avoiding
    disk reads that would exceed the latency budget.

The InMemoryVoiceProfileStore from conftest.py mirrors the TypeScript
VoiceProfileStore hot-LRU semantics:
  - Last `hotCacheSize` (default 30) accessed profiles are "hot".
  - `find_best_match()` over hot profiles is an in-memory cosine scan.
  - No disk I/O during hot lookup.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pytest

from conftest import (
    InMemoryVoiceProfileStore,
    SpeakerEncoder,
    TARGET_SR,
    load_fixture_audio,
)

# 50 ms budget per the spec
LATENCY_BUDGET_MS = 50.0
# For statistical stability, run N trials and take the median
N_TRIALS = 20


class TestOwnerLRUCache:
    """Validate that hot profile lookups complete within the 50 ms budget."""

    def test_hot_profile_match_under_50ms(
        self, encoder: SpeakerEncoder, manifest: dict
    ):
        """
        Enroll sam as the OWNER, then time repeated match calls.
        Median latency must be < 50 ms.
        """
        store = InMemoryVoiceProfileStore(hot_cache_size=30, match_threshold=0.40)

        # Enroll owner profile
        pcm = load_fixture_audio(manifest["f1_sam_solo"]["path"])
        n = len(pcm) // 4
        enroll_embedding = encoder.encode(pcm[:n])
        prof = store.add_or_refine(enroll_embedding, entity_id="owner-entity-id")

        assert store.is_hot(prof.profile_id), "Owner profile should be hot immediately after enrollment"

        # Probe embedding (different window of same speaker)
        probe_embedding = encoder.encode(pcm[n:2*n])

        # Time N_TRIALS match calls
        latencies_ms = []
        for _ in range(N_TRIALS):
            t0 = time.perf_counter()
            match, sim = store.find_best_match(probe_embedding)
            t1 = time.perf_counter()
            latencies_ms.append((t1 - t0) * 1000)

        median_ms = float(np.median(latencies_ms))
        p95_ms = float(np.percentile(latencies_ms, 95))

        assert match is not None, "No match found for hot owner profile"
        assert median_ms < LATENCY_BUDGET_MS, (
            f"Hot profile match median latency {median_ms:.2f} ms exceeds "
            f"{LATENCY_BUDGET_MS} ms budget"
        )
        # p95 is informational — logged in the artifact, not asserted here
        # since wall-clock variance from CI noise can exceed p95 budgets

    def test_lru_eviction_does_not_lose_bound_profiles(
        self, encoder: SpeakerEncoder, manifest: dict
    ):
        """
        After filling the hot cache beyond its capacity, bound profiles
        (entityId != null) must still be findable (from cold storage in the
        real TypeScript store; here we assert they remain in the profile map).
        """
        store = InMemoryVoiceProfileStore(hot_cache_size=5, match_threshold=0.40)

        # Enroll owner
        pcm = load_fixture_audio(manifest["f1_sam_solo"]["path"])
        n = len(pcm) // 4
        owner_emb = encoder.encode(pcm[:n])
        owner_prof = store.add_or_refine(owner_emb, entity_id="owner-entity-id")

        # Fill hot cache beyond capacity with random dummy profiles
        for i in range(10):
            dummy_emb = np.random.randn(encoder.dim).astype(np.float32)
            dummy_emb /= max(np.linalg.norm(dummy_emb), 1e-8)
            store.add_or_refine(dummy_emb, entity_id=None)

        # Owner profile should still be findable (in profile map even if evicted from hot)
        assert owner_prof.profile_id in store.profiles, (
            "Owner profile was removed from profile map after LRU eviction — "
            "bound profiles must never be deleted"
        )

        probe_emb = encoder.encode(pcm[n:2*n])
        match, sim = store.find_best_match(probe_emb)
        assert match is not None, "Owner profile not findable after cache eviction"

    def test_hot_cache_size_respected(self, encoder: SpeakerEncoder, manifest: dict):
        """The hot cache must not exceed its configured capacity."""
        capacity = 5
        store = InMemoryVoiceProfileStore(hot_cache_size=capacity)

        for i in range(capacity + 3):
            emb = np.random.randn(encoder.dim).astype(np.float32)
            emb /= max(np.linalg.norm(emb), 1e-8)
            store.add_or_refine(emb)

        assert len(store._hot_cache) <= capacity, (
            f"Hot cache grew to {len(store._hot_cache)} beyond capacity {capacity}"
        )

    def test_cold_profiles_still_matched(self, encoder: SpeakerEncoder, manifest: dict):
        """
        Profiles that have been evicted from the hot LRU must still be
        returned by find_best_match (searching all profiles, not just hot).
        """
        capacity = 3
        store = InMemoryVoiceProfileStore(hot_cache_size=capacity, match_threshold=0.40)

        # Enroll speaker A
        pcm = load_fixture_audio(manifest["f1_sam_solo"]["path"])
        n = len(pcm) // 4
        emb_a = encoder.encode(pcm[:n])
        prof_a = store.add_or_refine(emb_a, entity_id="speaker-a")

        # Fill cache so speaker A is evicted from hot
        for i in range(capacity + 2):
            emb = np.random.randn(encoder.dim).astype(np.float32)
            emb /= max(np.linalg.norm(emb), 1e-8)
            store.add_or_refine(emb)

        # Speaker A should not be hot
        assert not store.is_hot(prof_a.profile_id), (
            "Expected speaker A to be evicted from hot cache"
        )

        # But should still be found via full profile scan
        probe_a = encoder.encode(pcm[n:2*n])
        match, sim = store.find_best_match(probe_a)
        # Note: find_best_match scans ALL profiles, so even cold ones are found
        assert match is not None, "Cold profile not found by find_best_match"
        assert sim > 0.5, f"Cold profile match similarity {sim:.4f} suspiciously low"

    def test_write_latency_artifact(
        self, encoder: SpeakerEncoder, manifest: dict, artifacts_dir: Path
    ):
        """Write latency report to artifacts dir."""
        store = InMemoryVoiceProfileStore(hot_cache_size=30, match_threshold=0.40)
        pcm = load_fixture_audio(manifest["f1_sam_solo"]["path"])
        n = len(pcm) // 4

        enroll_emb = encoder.encode(pcm[:n])
        prof = store.add_or_refine(enroll_emb, entity_id="owner-entity-id")
        probe_emb = encoder.encode(pcm[n:2*n])

        latencies_ms = []
        for _ in range(N_TRIALS):
            t0 = time.perf_counter()
            store.find_best_match(probe_emb)
            t1 = time.perf_counter()
            latencies_ms.append((t1 - t0) * 1000)

        report = {
            "test": "owner_lru_cache",
            "budget_ms": LATENCY_BUDGET_MS,
            "n_trials": N_TRIALS,
            "median_ms": round(float(np.median(latencies_ms)), 3),
            "mean_ms": round(float(np.mean(latencies_ms)), 3),
            "p95_ms": round(float(np.percentile(latencies_ms, 95)), 3),
            "p99_ms": round(float(np.percentile(latencies_ms, 99)), 3),
            "max_ms": round(float(np.max(latencies_ms)), 3),
            "min_ms": round(float(np.min(latencies_ms)), 3),
            "pass": float(np.median(latencies_ms)) < LATENCY_BUDGET_MS,
            "hot_cache_size": 30,
            "profile_count": store.profile_count,
        }

        out_path = artifacts_dir / "latency-report.json"
        existing = {}
        if out_path.exists():
            with open(out_path) as f:
                existing = json.load(f)
        existing["owner_lru_cache"] = report

        with open(out_path, "w") as f:
            json.dump(existing, f, indent=2)

        assert report["pass"], (
            f"Hot profile median latency {report['median_ms']} ms exceeds "
            f"{LATENCY_BUDGET_MS} ms budget"
        )
