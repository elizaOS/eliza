from __future__ import annotations

import json
from pathlib import Path

from scripts import compare_text_conditioned_backends as compare_cli
from scripts.validate_backend_comparison_artifacts import (
    validate_backend_comparison_artifacts,
)


def test_backend_comparison_writes_single_artifact(
    monkeypatch,
    tmp_path: Path,
) -> None:
    def fake_train_alberta(
        profile_id,
        out_dir,
        *,
        total_steps,
        seed,
        include_tasks,
        pca_dim,
        episode_steps,
        eval_episodes,
        domain_rand,
    ):
        out_dir.mkdir(parents=True, exist_ok=True)
        return {
            "regime": "alberta_streaming",
            "profile_id": profile_id,
            "active_tasks": list(include_tasks),
            "total_steps": total_steps,
            "seed": seed,
            "pca_dim": pca_dim,
            "episode_steps": episode_steps,
            "eval_episodes": eval_episodes,
            "domain_rand": domain_rand,
        }

    def fake_train_ppo(
        profile_id,
        out_dir,
        *,
        total_steps,
        seed,
        include_tasks,
        pca_dim,
        domain_rand,
    ):
        out_dir.mkdir(parents=True, exist_ok=True)
        return {
            "regime": "smoke_sb3_ppo",
            "profile_id": profile_id,
            "active_tasks": list(include_tasks),
            "total_steps": total_steps,
            "seed": seed,
            "pca_dim": pca_dim,
            "domain_rand": domain_rand,
        }

    def fake_evaluate(
        profile_id,
        *,
        tasks,
        episodes,
        max_steps,
        untrained,
        ckpt=None,
        backend="profile",
    ):
        if untrained:
            mean = 1.0
            policy = "untrained_zero"
        elif ckpt and ckpt.name == "alberta":
            mean = 3.0
            policy = "alberta_streaming"
        else:
            mean = 2.0
            policy = "smoke_sb3_ppo"
        return {
            "profile_id": profile_id,
            "policy": policy,
            "checkpoint": "" if ckpt is None else str(ckpt),
            "tasks": {
                task: {"mean_reward": mean, "episodes": episodes}
                for task in tasks
            },
            "mean_reward_overall": mean,
            "max_steps": max_steps,
            "backend": backend,
        }

    def fake_validate_alberta(
        checkpoint,
        *,
        profile_id,
        required_tasks,
        min_steps,
        require_domain_rand,
        require_inference,
    ):
        return {
            "ok": True,
            "checkpoint": str(checkpoint),
            "profile_id": profile_id,
            "required_tasks": list(required_tasks),
            "min_steps": min_steps,
            "checks": {
                "profile_id": True,
                "required_tasks": True,
                "total_steps": True,
                "domain_rand": True,
                "inference": require_inference,
            },
            "require_domain_rand": require_domain_rand,
        }

    monkeypatch.setattr(compare_cli.train_text_conditioned, "_train_alberta", fake_train_alberta)
    monkeypatch.setattr(compare_cli.train_text_conditioned, "_train_ppo", fake_train_ppo)
    monkeypatch.setattr(compare_cli.eval_text_policy, "evaluate", fake_evaluate)
    monkeypatch.setattr(compare_cli, "validate_alberta_robot_checkpoint", fake_validate_alberta)

    report = compare_cli.compare(
        profile_id="unitree-g1",
        tasks=("stand_up", "walk_forward"),
        out_root=tmp_path,
        steps=10,
        seed=7,
        pca_dim=16,
        episode_steps=5,
        eval_episodes=2,
        max_steps=5,
        domain_rand=False,
        eval_backend="profile",
        train_ppo=True,
    )

    assert report["winner_by_mean_reward"] == "alberta"
    assert report["alberta_vs_ppo_delta"]["mean_reward_overall"] == 1.0
    assert report["alberta_vs_ppo_delta"]["tasks"]["stand_up"] == 1.0
    assert report["alberta"]["delta_vs_untrained"]["stand_up"] == 2.0
    assert report["alberta"]["manifest"]["domain_rand"] is False
    assert report["alberta"]["manifest"]["episode_steps"] == 5
    assert report["alberta"]["manifest"]["eval_episodes"] == 2
    assert report["alberta"]["validation"]["ok"] is True
    assert report["alberta"]["validation"]["required_tasks"] == ["stand_up", "walk_forward"]
    assert report["alberta"]["validation"]["require_domain_rand"] is False
    assert report["ppo"]["manifest"]["domain_rand"] is False
    assert report["ppo"]["delta_vs_untrained"]["walk_forward"] == 1.0
    assert (tmp_path / "comparison.json").is_file()
    assert (tmp_path / "comparison.md").is_file()
    assert "Alberta vs PPO" in (tmp_path / "comparison.md").read_text()
    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )
    assert validation["ok"] is True
    assert validation["checks"]["winner_consistent"] is True
    assert validation["checks"]["alberta_vs_ppo_delta"] is True
    assert validation["checks"]["alberta_delta_vs_untrained"] is True
    assert validation["checks"]["ppo_delta_vs_untrained"] is True
    assert validation["checks"]["eval_config"] is True
    assert validation["checks"]["eval_rollout_depth"] is True
    assert validation["eval_config"]["seed"] == 7
    assert validation["eval_config"]["pca_dim"] == 16
    assert validation["eval_config"]["episode_steps"] == 5
    assert validation["eval_config"]["eval_episodes"] == 2
    assert validation["eval_config"]["max_steps"] == 5
    assert validation["eval_config"]["domain_rand"] is False
    assert validation["deltas"]["baseline_mean_reward"] == 1.0
    assert validation["deltas"]["alberta_minus_ppo_mean_reward"] == 1.0
    assert validation["deltas"]["alberta_minus_untrained_mean_reward"] == 2.0
    assert validation["deltas"]["ppo_minus_untrained_mean_reward"] == 1.0
    assert validation["deltas"]["expected_winner_by_mean_reward"] == "alberta"


def test_backend_comparison_validator_can_require_meaningful_rollout_depth(
    tmp_path: Path,
) -> None:
    (tmp_path / "comparison.md").write_text(
        "# Alberta vs PPO\n\n## Per-Task Reward\n\ndelta vs untrained\n\n"
        "Winner by mean reward\n",
        encoding="utf-8",
    )
    (tmp_path / "comparison.json").write_text(
        json.dumps(
            {
                "profile_id": "unitree-g1",
                "tasks": ["stand_up"],
                "steps": 100,
                "seed": 7,
                "pca_dim": 16,
                "episode_steps": 50,
                "eval_episodes": 2,
                "max_steps": 50,
                "domain_rand": True,
                "baseline": {
                    "tasks": {
                        "stand_up": {
                            "mean_reward": 1.0,
                            "mean_steps_survived": 1.0,
                        }
                    },
                    "mean_reward_overall": 1.0,
                },
                "alberta": {
                    "validation": {"ok": True},
                    "eval": {
                        "tasks": {
                            "stand_up": {
                                "mean_reward": 3.0,
                                "mean_steps_survived": 1.0,
                            }
                        },
                        "mean_reward_overall": 3.0,
                    },
                    "delta_vs_untrained": {"stand_up": 2.0},
                },
                "ppo": {
                    "eval": {
                        "tasks": {
                            "stand_up": {
                                "mean_reward": 2.0,
                                "mean_steps_survived": 1.0,
                            }
                        },
                        "mean_reward_overall": 2.0,
                    },
                    "delta_vs_untrained": {"stand_up": 1.0},
                },
                "alberta_vs_ppo_delta": {
                    "mean_reward_overall": 1.0,
                    "tasks": {"stand_up": 1.0},
                },
                "winner_by_mean_reward": "alberta",
            }
        ),
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=100,
        min_eval_mean_steps=10.0,
    )

    assert validation["ok"] is False
    assert validation["checks"]["eval_rollout_depth"] is False
    assert validation["survival"]["min_mean_steps_survived"] == 1.0


def test_backend_comparison_rejects_invalid_alberta_checkpoint(
    monkeypatch,
    tmp_path: Path,
) -> None:
    def fake_train_alberta(profile_id, out_dir, **kwargs):
        out_dir.mkdir(parents=True, exist_ok=True)
        return {"regime": "alberta_streaming", "profile_id": profile_id}

    monkeypatch.setattr(compare_cli.train_text_conditioned, "_train_alberta", fake_train_alberta)
    monkeypatch.setattr(
        compare_cli,
        "validate_alberta_robot_checkpoint",
        lambda *_args, **_kwargs: {
            "ok": False,
            "checks": {"policy_artifact": False},
        },
    )

    try:
        compare_cli.compare(
            profile_id="unitree-g1",
            tasks=("stand_up",),
            out_root=tmp_path,
            steps=10,
            seed=7,
            pca_dim=16,
            episode_steps=5,
            eval_episodes=2,
            max_steps=5,
            domain_rand=True,
            eval_backend="profile",
            train_ppo=False,
        )
    except RuntimeError as exc:
        assert "Alberta checkpoint validation failed" in str(exc)
        assert "policy_artifact" in str(exc)
    else:
        raise AssertionError("expected invalid Alberta checkpoint to fail comparison")


def test_backend_comparison_generation_rejects_invalid_eval_rewards(
    monkeypatch,
    tmp_path: Path,
) -> None:
    def fake_train_alberta(profile_id, out_dir, **kwargs):
        out_dir.mkdir(parents=True, exist_ok=True)
        return {
            "regime": "alberta_streaming",
            "profile_id": profile_id,
            "active_tasks": list(kwargs["include_tasks"]),
            "total_steps": kwargs["total_steps"],
            "domain_rand": kwargs["domain_rand"],
        }

    def fake_validate_alberta(checkpoint, **kwargs):
        return {"ok": True, "checks": {"inference": True}}

    def fake_evaluate(
        profile_id,
        *,
        tasks,
        episodes,
        max_steps,
        untrained,
        ckpt=None,
        backend="profile",
    ):
        return {
            "profile_id": profile_id,
            "tasks": {task: {"mean_reward": True} for task in tasks},
            "mean_reward_overall": 1.0,
        }

    monkeypatch.setattr(compare_cli.train_text_conditioned, "_train_alberta", fake_train_alberta)
    monkeypatch.setattr(compare_cli, "validate_alberta_robot_checkpoint", fake_validate_alberta)
    monkeypatch.setattr(compare_cli.eval_text_policy, "evaluate", fake_evaluate)

    try:
        compare_cli.compare(
            profile_id="unitree-g1",
            tasks=("stand_up",),
            out_root=tmp_path,
            steps=10,
            seed=7,
            pca_dim=16,
            episode_steps=5,
            eval_episodes=2,
            max_steps=5,
            domain_rand=True,
            eval_backend="profile",
            train_ppo=False,
        )
    except RuntimeError as exc:
        assert "invalid task rewards" in str(exc)
    else:
        raise AssertionError("expected invalid eval rewards to fail comparison generation")


def test_backend_comparison_validator_rejects_inconsistent_winner_and_delta(
    tmp_path: Path,
) -> None:
    (tmp_path / "comparison.md").write_text("# Alberta vs PPO\n", encoding="utf-8")
    (tmp_path / "comparison.json").write_text(
        """
{
  "profile_id": "unitree-g1",
  "tasks": ["stand_up"],
  "steps": 10,
  "seed": 7,
  "pca_dim": 16,
  "episode_steps": 5,
  "eval_episodes": 2,
  "max_steps": 5,
  "domain_rand": true,
  "baseline": {
    "tasks": {"stand_up": {"mean_reward": 0.0}},
    "mean_reward_overall": 0.0
  },
  "alberta": {
    "validation": {"ok": true},
    "eval": {
      "tasks": {"stand_up": {"mean_reward": 1.0}},
      "mean_reward_overall": 1.0
    }
  },
  "ppo": {
    "eval": {
      "tasks": {"stand_up": {"mean_reward": 2.0}},
      "mean_reward_overall": 2.0
    }
  },
  "alberta_vs_ppo_delta": {
    "mean_reward_overall": 100.0,
    "tasks": {"stand_up": -1.0}
  },
  "winner_by_mean_reward": "alberta"
}
""",
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )

    assert validation["ok"] is False
    assert validation["checks"]["alberta_vs_ppo_delta"] is False
    assert validation["checks"]["winner_consistent"] is False
    assert validation["deltas"]["expected_winner_by_mean_reward"] == "ppo"


def test_backend_comparison_validator_rejects_inconsistent_per_task_delta(
    tmp_path: Path,
) -> None:
    (tmp_path / "comparison.md").write_text(
        "# Alberta vs PPO\n\n## Per-Task Reward\n\ndelta vs untrained\n\n"
        "Winner by mean reward\n",
        encoding="utf-8",
    )
    (tmp_path / "comparison.json").write_text(
        """
{
  "profile_id": "unitree-g1",
  "tasks": ["stand_up", "walk_forward"],
  "steps": 10,
  "seed": 7,
  "pca_dim": 16,
  "episode_steps": 5,
  "eval_episodes": 2,
  "max_steps": 5,
  "domain_rand": true,
  "baseline": {
    "tasks": {
      "stand_up": {"mean_reward": 0.0},
      "walk_forward": {"mean_reward": 0.0}
    },
    "mean_reward_overall": 0.0
  },
  "alberta": {
    "validation": {"ok": true},
    "eval": {
      "tasks": {
        "stand_up": {"mean_reward": 3.0},
        "walk_forward": {"mean_reward": 1.0}
      },
      "mean_reward_overall": 2.0
    },
    "delta_vs_untrained": {"stand_up": 3.0, "walk_forward": 1.0}
  },
  "ppo": {
    "eval": {
      "tasks": {
        "stand_up": {"mean_reward": 2.0},
        "walk_forward": {"mean_reward": 2.0}
      },
      "mean_reward_overall": 2.0
    },
    "delta_vs_untrained": {"stand_up": 2.0, "walk_forward": 2.0}
  },
  "alberta_vs_ppo_delta": {
    "mean_reward_overall": 0.0,
    "tasks": {"stand_up": 1.0, "walk_forward": 1.0}
  },
  "winner_by_mean_reward": "alberta"
}
""",
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )

    assert validation["ok"] is False
    assert validation["checks"]["alberta_vs_ppo_delta"] is False
    assert validation["checks"]["winner_consistent"] is True


def test_backend_comparison_validator_rejects_inconsistent_untrained_delta(
    tmp_path: Path,
) -> None:
    (tmp_path / "comparison.md").write_text("# Alberta vs PPO\n", encoding="utf-8")
    (tmp_path / "comparison.json").write_text(
        """
{
  "profile_id": "unitree-g1",
  "tasks": ["stand_up"],
  "steps": 10,
  "seed": 7,
  "pca_dim": 16,
  "episode_steps": 5,
  "eval_episodes": 2,
  "max_steps": 5,
  "domain_rand": true,
  "baseline": {
    "tasks": {"stand_up": {"mean_reward": 1.0}},
    "mean_reward_overall": 1.0
  },
  "alberta": {
    "validation": {"ok": true},
    "eval": {
      "tasks": {"stand_up": {"mean_reward": 3.0}},
      "mean_reward_overall": 3.0
    },
    "delta_vs_untrained": {"stand_up": 99.0}
  },
  "ppo": {
    "eval": {
      "tasks": {"stand_up": {"mean_reward": 2.0}},
      "mean_reward_overall": 2.0
    },
    "delta_vs_untrained": {"stand_up": 1.0}
  },
  "alberta_vs_ppo_delta": {
    "mean_reward_overall": 1.0,
    "tasks": {"stand_up": 1.0}
  },
  "winner_by_mean_reward": "alberta"
}
""",
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )

    assert validation["ok"] is False
    assert validation["checks"]["alberta_delta_vs_untrained"] is False
    assert validation["checks"]["ppo_delta_vs_untrained"] is True
    assert validation["deltas"]["alberta_minus_untrained_mean_reward"] == 2.0


def test_backend_comparison_validator_rejects_nan_rewards(tmp_path: Path) -> None:
    (tmp_path / "comparison.md").write_text(
        "# Alberta vs PPO\n\n## Per-Task Reward\n\ndelta vs untrained\n\n"
        "Winner by mean reward\n",
        encoding="utf-8",
    )
    (tmp_path / "comparison.json").write_text(
        json.dumps(
            {
                "profile_id": "unitree-g1",
                "tasks": ["stand_up"],
                "steps": 10,
                "seed": 7,
                "pca_dim": 16,
                "episode_steps": 5,
                "eval_episodes": 2,
                "max_steps": 5,
                "domain_rand": True,
                "baseline": {
                    "tasks": {"stand_up": {"mean_reward": 1.0}},
                    "mean_reward_overall": 1.0,
                },
                "alberta": {
                    "validation": {"ok": True},
                    "eval": {
                        "tasks": {"stand_up": {"mean_reward": float("nan")}},
                        "mean_reward_overall": 3.0,
                    },
                    "delta_vs_untrained": {"stand_up": 2.0},
                },
                "ppo": {
                    "eval": {
                        "tasks": {"stand_up": {"mean_reward": 2.0}},
                        "mean_reward_overall": float("inf"),
                    },
                    "delta_vs_untrained": {"stand_up": 1.0},
                },
                "alberta_vs_ppo_delta": {
                    "mean_reward_overall": 1.0,
                    "tasks": {"stand_up": 1.0},
                },
                "winner_by_mean_reward": "alberta",
            }
        ),
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )

    assert validation["ok"] is False
    assert validation["checks"]["alberta_eval"] is False
    assert validation["checks"]["mean_rewards"] is False


def test_backend_comparison_validator_rejects_boolean_rewards(tmp_path: Path) -> None:
    (tmp_path / "comparison.md").write_text(
        "# Alberta vs PPO\n\n## Per-Task Reward\n\ndelta vs untrained\n\n"
        "Winner by mean reward\n",
        encoding="utf-8",
    )
    (tmp_path / "comparison.json").write_text(
        json.dumps(
            {
                "profile_id": "unitree-g1",
                "tasks": ["stand_up"],
                "steps": 10,
                "seed": 7,
                "pca_dim": 16,
                "episode_steps": 5,
                "eval_episodes": 2,
                "max_steps": 5,
                "domain_rand": True,
                "baseline": {
                    "tasks": {"stand_up": {"mean_reward": 1.0}},
                    "mean_reward_overall": 1.0,
                },
                "alberta": {
                    "validation": {"ok": True},
                    "eval": {
                        "tasks": {"stand_up": {"mean_reward": True}},
                        "mean_reward_overall": 3.0,
                    },
                    "delta_vs_untrained": {"stand_up": 2.0},
                },
                "ppo": {
                    "eval": {
                        "tasks": {"stand_up": {"mean_reward": 2.0}},
                        "mean_reward_overall": 2.0,
                    },
                    "delta_vs_untrained": {"stand_up": 1.0},
                },
                "alberta_vs_ppo_delta": {
                    "mean_reward_overall": 1.0,
                    "tasks": {"stand_up": 1.0},
                },
                "winner_by_mean_reward": "alberta",
            }
        ),
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )

    assert validation["ok"] is False
    assert validation["checks"]["alberta_eval"] is False


def test_backend_comparison_validator_rejects_missing_eval_config(
    tmp_path: Path,
) -> None:
    (tmp_path / "comparison.md").write_text(
        "# Alberta vs PPO\n\n## Per-Task Reward\n\ndelta vs untrained\n\n"
        "Winner by mean reward\n",
        encoding="utf-8",
    )
    (tmp_path / "comparison.json").write_text(
        """
{
  "profile_id": "unitree-g1",
  "tasks": ["stand_up"],
  "steps": 10,
  "baseline": {
    "tasks": {"stand_up": {"mean_reward": 1.0}},
    "mean_reward_overall": 1.0
  },
  "alberta": {
    "validation": {"ok": true},
    "eval": {
      "tasks": {"stand_up": {"mean_reward": 3.0}},
      "mean_reward_overall": 3.0
    },
    "delta_vs_untrained": {"stand_up": 2.0}
  },
  "ppo": {
    "eval": {
      "tasks": {"stand_up": {"mean_reward": 2.0}},
      "mean_reward_overall": 2.0
    },
    "delta_vs_untrained": {"stand_up": 1.0}
  },
  "alberta_vs_ppo_delta": {
    "mean_reward_overall": 1.0,
    "tasks": {"stand_up": 1.0}
  },
  "winner_by_mean_reward": "alberta"
}
""",
        encoding="utf-8",
    )

    validation = validate_backend_comparison_artifacts(
        tmp_path,
        expected_profile="unitree-g1",
        min_steps=10,
    )

    assert validation["ok"] is False
    assert validation["checks"]["eval_config"] is False
