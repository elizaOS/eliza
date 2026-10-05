from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


SCHEMA_VERSION = "eliza.voice_profile_lifecycle.v1"
LABEL_THRESHOLD = 0.82
SENSITIVE_THRESHOLD = 0.94
VECTOR_DIM = 16


def _unit(values: list[float] | np.ndarray) -> np.ndarray:
    vector = np.asarray(values, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-8:
        raise ValueError("embedding vector must be non-zero")
    return vector / norm


def _basis(index: int) -> np.ndarray:
    vector = np.zeros(VECTOR_DIM, dtype=np.float32)
    vector[index] = 1.0
    return vector


def _variant(base: np.ndarray, orthogonal_axis: int, target_cosine: float) -> np.ndarray:
    if not 0 <= target_cosine <= 1:
        raise ValueError("target cosine must be between 0 and 1")
    return _unit(
        (base * target_cosine)
        + (_basis(orthogonal_axis) * math.sqrt(max(0.0, 1.0 - target_cosine**2)))
    )


def _cosine(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.dot(left, right))


def _embedding_hash(embedding: np.ndarray) -> str:
    return hashlib.sha256(embedding.astype(np.float32).tobytes()).hexdigest()[:16]


@dataclass(frozen=True)
class VoiceSample:
    sample_id: str
    speaker_id: str | None
    duration_s: float
    condition: str
    embedding: np.ndarray
    text: str = ""
    spoof_risk: bool = False


@dataclass
class VoiceProfile:
    profile_id: str
    speaker_id: str
    display_name: str
    name_provenance: str
    centroid: np.ndarray
    sample_ids: list[str]
    active: bool = True
    revoked: bool = False
    bound_entity_id: str | None = None
    user_confirmed_name: bool = False

    def public_dict(self) -> dict[str, Any]:
        return {
            "profileId": self.profile_id,
            "speakerId": self.speaker_id,
            "displayName": self.display_name,
            "nameProvenance": self.name_provenance,
            "sampleCount": len(self.sample_ids),
            "active": self.active,
            "revoked": self.revoked,
            "boundEntityId": self.bound_entity_id,
            "userConfirmedName": self.user_confirmed_name,
            "embeddingHash": _embedding_hash(self.centroid),
        }


class VoiceProfileLifecycleStore:
    def __init__(self) -> None:
        self._profiles: dict[str, VoiceProfile] = {}

    @property
    def profiles(self) -> dict[str, VoiceProfile]:
        return self._profiles

    def enroll(
        self,
        *,
        profile_id: str,
        speaker_id: str,
        display_name: str,
        name_provenance: str,
        sample: VoiceSample,
    ) -> VoiceProfile:
        if profile_id in self._profiles:
            raise ValueError(f"profile already exists: {profile_id}")
        profile = VoiceProfile(
            profile_id=profile_id,
            speaker_id=speaker_id,
            display_name=display_name,
            name_provenance=name_provenance,
            centroid=sample.embedding.copy(),
            sample_ids=[sample.sample_id],
        )
        self._profiles[profile_id] = profile
        return profile

    def add_sample(self, profile_id: str, sample: VoiceSample) -> VoiceProfile:
        profile = self._profiles[profile_id]
        count = len(profile.sample_ids)
        profile.centroid = _unit((profile.centroid * count) + sample.embedding)
        profile.sample_ids.append(sample.sample_id)
        return profile

    def rename(self, profile_id: str, display_name: str, provenance: str) -> dict[str, Any]:
        profile = self._profiles[profile_id]
        before = profile.display_name
        profile.display_name = display_name
        profile.name_provenance = provenance
        profile.user_confirmed_name = provenance == "user_confirmed"
        return {
            "operation": "rename",
            "profileId": profile_id,
            "before": before,
            "after": display_name,
            "provenance": provenance,
        }

    def merge(self, target_profile_id: str, source_profile_id: str) -> dict[str, Any]:
        target = self._profiles[target_profile_id]
        source = self._profiles[source_profile_id]
        target_count = len(target.sample_ids)
        source_count = len(source.sample_ids)
        target.centroid = _unit(
            (target.centroid * target_count) + (source.centroid * source_count)
        )
        target.sample_ids.extend(source.sample_ids)
        source.active = False
        source.revoked = True
        return {
            "operation": "merge",
            "targetProfileId": target_profile_id,
            "sourceProfileId": source_profile_id,
            "targetSampleCount": len(target.sample_ids),
            "sourceActive": source.active,
        }

    def split(
        self,
        source_profile_id: str,
        new_profile_id: str,
        *,
        speaker_id: str,
        display_name: str,
        sample: VoiceSample,
    ) -> dict[str, Any]:
        source = self._profiles[source_profile_id]
        if sample.sample_id in source.sample_ids:
            source.sample_ids.remove(sample.sample_id)
        new_profile = VoiceProfile(
            profile_id=new_profile_id,
            speaker_id=speaker_id,
            display_name=display_name,
            name_provenance="split_from_profile",
            centroid=sample.embedding.copy(),
            sample_ids=[sample.sample_id],
        )
        self._profiles[new_profile_id] = new_profile
        return {
            "operation": "split",
            "sourceProfileId": source_profile_id,
            "newProfileId": new_profile_id,
            "sourceSampleCount": len(source.sample_ids),
            "newSampleCount": len(new_profile.sample_ids),
        }

    def revoke(self, profile_id: str, reason: str) -> dict[str, Any]:
        profile = self._profiles[profile_id]
        profile.revoked = True
        profile.active = False
        return {"operation": "revoke", "profileId": profile_id, "reason": reason}

    def delete(self, profile_id: str) -> dict[str, Any]:
        existed = profile_id in self._profiles
        if existed:
            del self._profiles[profile_id]
        return {"operation": "delete", "profileId": profile_id, "existed": existed}

    def bind(self, profile_id: str, entity_id: str) -> dict[str, Any]:
        self._profiles[profile_id].bound_entity_id = entity_id
        return {"operation": "bind", "profileId": profile_id, "entityId": entity_id}

    def unbind(self, profile_id: str) -> dict[str, Any]:
        previous = self._profiles[profile_id].bound_entity_id
        self._profiles[profile_id].bound_entity_id = None
        return {"operation": "unbind", "profileId": profile_id, "previousEntityId": previous}

    def export_profile(self, profile_id: str) -> dict[str, Any]:
        profile = self._profiles[profile_id]
        exported = profile.public_dict()
        exported["rawEmbeddingIncluded"] = False
        return {"operation": "export", "profileId": profile_id, "profile": exported}

    def match(
        self,
        embedding: np.ndarray,
        *,
        threshold: float,
        sensitive_action: bool = False,
        spoof_risk: bool = False,
    ) -> dict[str, Any]:
        rankings = self.rank(embedding)
        best = rankings[0] if rankings else None
        if best is None or best["score"] < threshold:
            return {"decision": "unknown", "profileId": None, "score": best["score"] if best else 0.0}
        if sensitive_action and spoof_risk:
            return {
                "decision": "sensitive_rejected_spoof",
                "profileId": best["profileId"],
                "score": best["score"],
            }
        return {"decision": "matched", "profileId": best["profileId"], "score": best["score"]}

    def rank(self, embedding: np.ndarray) -> list[dict[str, Any]]:
        rows = []
        for profile in self._profiles.values():
            if not profile.active or profile.revoked:
                continue
            rows.append(
                {
                    "profileId": profile.profile_id,
                    "speakerId": profile.speaker_id,
                    "displayName": profile.display_name,
                    "score": round(_cosine(embedding, profile.centroid), 6),
                }
            )
        return sorted(rows, key=lambda row: row["score"], reverse=True)

    def snapshot(self, label: str) -> dict[str, Any]:
        profiles = [profile.public_dict() for profile in self._profiles.values()]
        profiles.sort(key=lambda row: row["profileId"])
        return {
            "label": label,
            "profileCount": len(profiles),
            "activeProfileCount": sum(1 for row in profiles if row["active"]),
            "revokedProfileCount": sum(1 for row in profiles if row["revoked"]),
            "profiles": profiles,
        }


def _samples() -> dict[str, VoiceSample]:
    owner = _basis(0)
    casey = _basis(1)
    mira = _basis(2)
    lee = _basis(3)
    unknown = _basis(4)
    similar_owner = _variant(owner, 5, 0.9)
    return {
        "owner_enroll": VoiceSample("owner_enroll", "owner", 10.0, "clean", owner),
        "owner_0_5s": VoiceSample("owner_0_5s", "owner", 0.5, "short_utterance", _variant(owner, 6, 0.86)),
        "owner_1s": VoiceSample("owner_1s", "owner", 1.0, "short_utterance", _variant(owner, 7, 0.88)),
        "owner_3s": VoiceSample("owner_3s", "owner", 3.0, "clean", _variant(owner, 8, 0.95)),
        "owner_10s": VoiceSample("owner_10s", "owner", 10.0, "clean", _variant(owner, 9, 0.98)),
        "casey_enroll": VoiceSample("casey_enroll", "casey", 10.0, "clean", casey),
        "casey_noise": VoiceSample("casey_noise", "casey", 3.0, "background_noise", _variant(casey, 10, 0.93)),
        "casey_music": VoiceSample("casey_music", "casey", 3.0, "music", _variant(casey, 11, 0.91)),
        "casey_overlap": VoiceSample("casey_overlap", "casey", 3.0, "overlap", _variant(casey, 12, 0.88)),
        "casey_merge": VoiceSample("casey_merge", "casey", 3.0, "duplicate_profile", _variant(casey, 13, 0.96)),
        "casey_split": VoiceSample("casey_split", "casey-split", 3.0, "manual_split", _basis(14)),
        "mira_intro": VoiceSample("mira_intro", "mira", 3.0, "self_introduction", mira, "I'm Mira"),
        "lee_calendar": VoiceSample("lee_calendar", "lee", 3.0, "calendar_name", lee),
        "unknown": VoiceSample("unknown", None, 3.0, "unknown_speaker", unknown),
        "similar_owner": VoiceSample("similar_owner", None, 3.0, "similar_voice", similar_owner),
        "replay_owner": VoiceSample(
            "replay_owner",
            None,
            3.0,
            "replay_spoof",
            _variant(owner, 15, 0.99),
            spoof_risk=True,
        ),
    }


def _build_metric_store(samples: dict[str, VoiceSample]) -> VoiceProfileLifecycleStore:
    store = VoiceProfileLifecycleStore()
    store.enroll(
        profile_id="profile-owner",
        speaker_id="owner",
        display_name="Owner",
        name_provenance="owner_enrollment",
        sample=samples["owner_enroll"],
    )
    store.enroll(
        profile_id="profile-casey",
        speaker_id="casey",
        display_name="Casey Nguyen",
        name_provenance="user_confirmed",
        sample=samples["casey_enroll"],
    )
    store.enroll(
        profile_id="profile-mira",
        speaker_id="mira",
        display_name="Mira",
        name_provenance="self_introduction",
        sample=samples["mira_intro"],
    )
    store.enroll(
        profile_id="profile-lee",
        speaker_id="lee",
        display_name="Sam Lee",
        name_provenance="user_correction",
        sample=samples["lee_calendar"],
    )
    return store


def _evaluate_metrics(store: VoiceProfileLifecycleStore, samples: dict[str, VoiceSample]) -> dict[str, Any]:
    attempts = [
        samples["owner_0_5s"],
        samples["owner_1s"],
        samples["owner_3s"],
        samples["owner_10s"],
        samples["casey_noise"],
        samples["casey_music"],
        samples["casey_overlap"],
        samples["mira_intro"],
        samples["lee_calendar"],
        samples["unknown"],
        samples["similar_owner"],
        samples["replay_owner"],
    ]

    rows = []
    same_scores: list[float] = []
    different_scores: list[float] = []
    confusion: dict[str, dict[str, int]] = {}
    duration_bins: dict[str, dict[str, int]] = {}
    top1_hits = 0
    top3_hits = 0
    known_count = 0
    sensitive_impostor_attempts = 0
    sensitive_impostor_accepts = 0
    label_impostor_accepts = 0

    for sample in attempts:
        label_decision = store.match(sample.embedding, threshold=LABEL_THRESHOLD)
        sensitive_decision = store.match(
            sample.embedding,
            threshold=SENSITIVE_THRESHOLD,
            sensitive_action=True,
            spoof_risk=sample.spoof_risk,
        )
        rankings = store.rank(sample.embedding)
        expected = sample.speaker_id or "unknown"
        predicted = "unknown"
        if label_decision["decision"] == "matched" and label_decision["profileId"]:
            predicted = store.profiles[label_decision["profileId"]].speaker_id
        confusion.setdefault(expected, {}).setdefault(predicted, 0)
        confusion[expected][predicted] += 1

        if sample.speaker_id:
            known_count += 1
            top_speakers = [row["speakerId"] for row in rankings[:3]]
            if top_speakers and top_speakers[0] == sample.speaker_id:
                top1_hits += 1
            if sample.speaker_id in top_speakers:
                top3_hits += 1
            matched_profile = next(
                profile for profile in store.profiles.values() if profile.speaker_id == sample.speaker_id
            )
            same_scores.append(_cosine(sample.embedding, matched_profile.centroid))
            bin_key = f"{sample.duration_s:g}s"
            duration_bins.setdefault(bin_key, {"total": 0, "correct": 0})
            duration_bins[bin_key]["total"] += 1
            if predicted == sample.speaker_id:
                duration_bins[bin_key]["correct"] += 1
            for profile in store.profiles.values():
                if profile.speaker_id != sample.speaker_id:
                    different_scores.append(_cosine(sample.embedding, profile.centroid))
        else:
            sensitive_impostor_attempts += 1
            if sensitive_decision["decision"] == "matched":
                sensitive_impostor_accepts += 1
            if label_decision["decision"] == "matched":
                label_impostor_accepts += 1
            for profile in store.profiles.values():
                different_scores.append(_cosine(sample.embedding, profile.centroid))

        rows.append(
            {
                "sampleId": sample.sample_id,
                "condition": sample.condition,
                "durationS": sample.duration_s,
                "expectedSpeakerId": expected,
                "labelDecision": label_decision,
                "sensitiveDecision": sensitive_decision,
                "top3": rankings[:3],
            }
        )

    threshold_rows = _threshold_sweep(same_scores, different_scores)
    eer_row = min(threshold_rows, key=lambda row: abs(row["far"] - row["frr"]))
    duration_report = {
        key: {
            "total": value["total"],
            "correct": value["correct"],
            "accuracy": round(value["correct"] / value["total"], 6),
        }
        for key, value in sorted(duration_bins.items())
    }
    return {
        "thresholds": {
            "meetingLabel": LABEL_THRESHOLD,
            "sensitiveAction": SENSITIVE_THRESHOLD,
        },
        "eer": round((eer_row["far"] + eer_row["frr"]) / 2, 6),
        "eerThreshold": eer_row["threshold"],
        "far": eer_row["far"],
        "frr": eer_row["frr"],
        "top1ProfileAccuracy": round(top1_hits / known_count, 6),
        "top3ProfileAccuracy": round(top3_hits / known_count, 6),
        "shortUtteranceDegradation": duration_report,
        "sameSpeakerCosine": _distribution(same_scores),
        "differentSpeakerCosine": _distribution(different_scores),
        "detRocPoints": threshold_rows,
        "confusionMatrix": confusion,
        "impostorAcceptRate": {
            "meetingLabel": round(label_impostor_accepts / sensitive_impostor_attempts, 6),
            "sensitiveAction": round(sensitive_impostor_accepts / sensitive_impostor_attempts, 6),
        },
        "notMeasured": {
            "lookupLatencyMs": "profile-lookup latency is not measured in this deterministic no-audio gate — a synthetic in-memory scan says nothing about production; captured in the live run (#13158)",
            "cacheHitRate": "profile cache hit-rate requires the live store; not measured here (#13158)",
        },
        "attempts": rows,
    }


def _distribution(values: list[float]) -> dict[str, float]:
    array = np.asarray(values, dtype=np.float32)
    return {
        "count": int(array.size),
        "min": round(float(array.min()), 6),
        "mean": round(float(array.mean()), 6),
        "max": round(float(array.max()), 6),
    }


def _threshold_sweep(same_scores: list[float], different_scores: list[float]) -> list[dict[str, float]]:
    rows = []
    same = np.asarray(same_scores, dtype=np.float32)
    different = np.asarray(different_scores, dtype=np.float32)
    for threshold in [0.5, 0.7, 0.82, 0.9, 0.94, 0.97, 0.99]:
        false_rejects = float(np.sum(same < threshold))
        false_accepts = float(np.sum(different >= threshold))
        true_accepts = float(np.sum(same >= threshold))
        true_rejects = float(np.sum(different < threshold))
        rows.append(
            {
                "threshold": threshold,
                "far": round(false_accepts / max(1, different.size), 6),
                "frr": round(false_rejects / max(1, same.size), 6),
                "tpr": round(true_accepts / max(1, same.size), 6),
                "fpr": round(false_accepts / max(1, different.size), 6),
                "tnr": round(true_rejects / max(1, different.size), 6),
            }
        )
    return rows


def build_lifecycle_report() -> dict[str, Any]:
    samples = _samples()
    store = VoiceProfileLifecycleStore()
    snapshots = [store.snapshot("empty")]

    store.enroll(
        profile_id="profile-owner",
        speaker_id="owner",
        display_name="Owner",
        name_provenance="owner_enrollment",
        sample=samples["owner_enroll"],
    )
    store.enroll(
        profile_id="profile-casey",
        speaker_id="casey",
        display_name="Casey",
        name_provenance="recurring_attendee_enrollment",
        sample=samples["casey_enroll"],
    )
    snapshots.append(store.snapshot("after-owner-and-recurring-enrollment"))

    unknown_decision = store.match(samples["unknown"].embedding, threshold=LABEL_THRESHOLD)
    self_intro = store.enroll(
        profile_id="profile-mira",
        speaker_id="mira",
        display_name="Mira",
        name_provenance="self_introduction",
        sample=samples["mira_intro"],
    )
    calendar = store.enroll(
        profile_id="profile-lee",
        speaker_id="lee",
        display_name="Dr. Lee",
        name_provenance="calendar_participant",
        sample=samples["lee_calendar"],
    )

    operations = [
        {
            "operation": "unknown_speaker_check",
            "decision": unknown_decision,
            "passed": unknown_decision["decision"] == "unknown",
        },
        {
            "operation": "self_introduction_naming",
            "profileId": self_intro.profile_id,
            "displayName": self_intro.display_name,
            "provenance": self_intro.name_provenance,
        },
        {
            "operation": "platform_calendar_name",
            "profileId": calendar.profile_id,
            "displayName": calendar.display_name,
            "provenance": calendar.name_provenance,
        },
        store.rename("profile-casey", "Casey Nguyen", "user_confirmed"),
        store.rename("profile-lee", "Sam Lee", "user_correction"),
    ]

    duplicate = store.enroll(
        profile_id="profile-casey-duplicate",
        speaker_id="casey",
        display_name="Casey duplicate",
        name_provenance="similar_voice_candidate",
        sample=samples["casey_merge"],
    )
    operations.append(
        {
            "operation": "duplicate_profile_created",
            "profileId": duplicate.profile_id,
            "speakerId": duplicate.speaker_id,
        }
    )
    operations.append(store.merge("profile-casey", "profile-casey-duplicate"))
    operations.append(
        store.split(
            "profile-casey",
            "profile-casey-split",
            speaker_id="casey-split",
            display_name="Casey split",
            sample=samples["casey_split"],
        )
    )
    operations.append(store.bind("profile-casey-split", "entity-casey-split"))
    operations.append(store.unbind("profile-casey-split"))

    temp = store.enroll(
        profile_id="profile-temp",
        speaker_id="temp",
        display_name="Temporary Speaker",
        name_provenance="manual_test",
        sample=VoiceSample("temp_enroll", "temp", 3.0, "temporary", _basis(15)),
    )
    operations.append(store.export_profile(temp.profile_id))
    operations.append(store.revoke(temp.profile_id, "user_revoked_consent"))
    operations.append(store.delete(temp.profile_id))
    snapshots.append(store.snapshot("after-lifecycle-operations"))

    metric_store = _build_metric_store(samples)
    metrics = _evaluate_metrics(metric_store, samples)
    coverage = {
        "ownerEnrollment": True,
        "recurringAttendeeEnrollment": True,
        "unknownSpeakerRemainsUnknown": unknown_decision["decision"] == "unknown",
        "userConfirmedNaming": True,
        "userCorrection": True,
        "selfIntroductionNaming": True,
        "platformCalendarNameProvenance": True,
        "merge": True,
        "split": True,
        "delete": True,
        "revoke": True,
        "export": True,
        "bind": True,
        "unbind": True,
        "shortUtteranceBins": ["0.5s", "1s", "3s", "10s"],
        "similarVoices": True,
        "backgroundNoise": True,
        "music": True,
        "overlap": True,
        "replaySpoof": True,
        "metrics": ["EER", "FAR", "FRR", "top1", "top3", "DET/ROC", "confusionMatrix"],
    }
    gates = {
        "unknownSpeakerRemainsUnknown": coverage["unknownSpeakerRemainsUnknown"],
        "top1ProfileAccuracyAtLeastOne": metrics["top1ProfileAccuracy"] == 1.0,
        "top3ProfileAccuracyAtLeastOne": metrics["top3ProfileAccuracy"] == 1.0,
        "sensitiveRejectsReplaySpoof": any(
            attempt["sampleId"] == "replay_owner"
            and attempt["sensitiveDecision"]["decision"] == "sensitive_rejected_spoof"
            for attempt in metrics["attempts"]
        ),
        "sensitiveImpostorAcceptRateBelowMeetingLabel": (
            metrics["impostorAcceptRate"]["sensitiveAction"]
            < metrics["impostorAcceptRate"]["meetingLabel"]
        ),
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "benchmark": "voice-profile-lifecycle",
        "fixtureMode": "deterministic-synthetic-embeddings",
        "thresholds": {
            "meetingLabel": LABEL_THRESHOLD,
            "sensitiveAction": SENSITIVE_THRESHOLD,
        },
        "coverage": coverage,
        "gates": gates,
        "operations": operations,
        "storeSnapshots": snapshots,
        "metrics": metrics,
        "evidenceLimitations": [
            "Synthetic embeddings prove lifecycle and metric math only.",
            "Real audio samples, live model trajectories, UI screenshots, and walkthrough video are human-gated evidence.",
        ],
    }


def write_lifecycle_report(path: Path | str) -> dict[str, Any]:
    report = build_lifecycle_report()
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    return report


def main() -> None:
    default_path = Path("artifacts") / "voice-profile-lifecycle.json"
    write_lifecycle_report(default_path)
    print(default_path)


if __name__ == "__main__":
    main()
