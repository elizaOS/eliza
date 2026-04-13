"""Ground Truth World — v2 (realistic handles, opaque IDs).

14 entities across discord/twitter/telegram.
Handles are messy and realistic — no "dave_discord" / "dave_twitter".
3 cross-platform resolution links at easy/medium/hard.
2+ anti-links (name collision + adversarial claim).
"""

from .types import AntiLink, GroundTruthLink, GroundTruthWorld, WorldEntity

WORLD = GroundTruthWorld(
    entities=[
        # ── Dave Morales: Discord + Twitter ───────
        # Resolution: MEDIUM — different handles, shared github + project "ChainTracker"
        WorldEntity(
            id="ent_d1",
            canonical_person="dave",
            display_name="d4v3_builds",
            platform="discord",
            platform_handle="d4v3_builds",
            attributes={"project": "ChainTracker", "event": "ETH Denver"},
        ),
        WorldEntity(
            id="ent_d2",
            canonical_person="dave",
            display_name="chaintrack3r",
            platform="twitter",
            platform_handle="@chaintrack3r",
            attributes={"project": "ChainTracker", "event": "ETH Denver"},
        ),
        # ── "CryptoWhale" anon: Discord + Twitter ──
        # Resolution: HARD — completely different handles, linked ONLY by
        # self-identification + project "NightOwl"
        WorldEntity(
            id="ent_w1",
            canonical_person="whale",
            display_name="WhaleAlert42",
            platform="discord",
            platform_handle="WhaleAlert42",
            attributes={"project": "NightOwl Protocol"},
        ),
        WorldEntity(
            id="ent_w2",
            canonical_person="whale",
            display_name="nightowl_dev",
            platform="twitter",
            platform_handle="@nightowl_dev",
            attributes={"project": "NightOwl Protocol"},
        ),
        # ── Alice Rivera: Discord + Twitter ──────
        # Resolution: EASY — self-reports twitter handle in Discord
        WorldEntity(
            id="ent_a1",
            canonical_person="alice",
            display_name="alice_mod",
            platform="discord",
            platform_handle="alice_mod",
            attributes={"role": "admin"},
        ),
        WorldEntity(
            id="ent_a2",
            canonical_person="alice",
            display_name="alice_web3",
            platform="twitter",
            platform_handle="@alice_web3",
            attributes={"role": "community lead"},
        ),
        # ── Single-platform entities ─────────────
        WorldEntity(
            id="ent_s1",
            canonical_person="sarah",
            display_name="sarahc.eth",
            platform="discord",
            platform_handle="sarahc.eth",
            attributes={"occupation": "frontend dev"},
        ),
        WorldEntity(
            id="ent_b1",
            canonical_person="bob",
            display_name="bobk",
            platform="discord",
            platform_handle="bobk",
            attributes={"occupation": "backend dev"},
        ),
        WorldEntity(
            id="ent_e1",
            canonical_person="eve",
            display_name="TotallyLegit_Admin",
            platform="discord",
            platform_handle="TotallyLegit_Admin",
            attributes={"intent": "malicious"},
        ),
        WorldEntity(
            id="ent_m1",
            canonical_person="marcus",
            display_name="marcus_dev",
            platform="discord",
            platform_handle="marcus_dev",
            attributes={"occupation": "junior dev"},
        ),
        WorldEntity(
            id="ent_p1",
            canonical_person="priya",
            display_name="priya_ships",
            platform="twitter",
            platform_handle="@priya_ships",
            attributes={"occupation": "PM"},
        ),
        WorldEntity(
            id="ent_x1",
            canonical_person="alex_designer",
            display_name="alexr_design",
            platform="discord",
            platform_handle="alexr_design",
            attributes={"occupation": "UI designer", "location": "SF"},
        ),
        WorldEntity(
            id="ent_x2",
            canonical_person="alex_engineer",
            display_name="petrovalex",
            platform="discord",
            platform_handle="petrovalex",
            attributes={"occupation": "distributed systems", "location": "London"},
        ),
        WorldEntity(
            id="ent_j1",
            canonical_person="jordan",
            display_name="j0rdan_nft",
            platform="discord",
            platform_handle="j0rdan_nft",
            attributes={},
        ),
    ],
    links=[
        GroundTruthLink(
            entity_a="ent_d1",
            entity_b="ent_d2",
            difficulty="medium",
            reason=(
                "d4v3_builds (Discord) + chaintrack3r (Twitter): both share "
                "github.com/davebuilds and project ChainTracker"
            ),
            expected_signals=[
                "shared_github_handle:davebuilds",
                "shared_project:ChainTracker",
            ],
        ),
        GroundTruthLink(
            entity_a="ent_a1",
            entity_b="ent_a2",
            difficulty="easy",
            reason="alice_mod (Discord) self-reports twitter @alice_web3",
            expected_signals=["self_reported_handle:@alice_web3"],
        ),
        GroundTruthLink(
            entity_a="ent_w1",
            entity_b="ent_w2",
            difficulty="hard",
            reason=(
                "WhaleAlert42 (Discord) verbally confirms being "
                "@nightowl_dev (Twitter). NO handle overlap."
            ),
            expected_signals=["verbal_self_identification:@nightowl_dev"],
        ),
    ],
    anti_links=[
        AntiLink(
            entity_a="ent_x1",
            entity_b="ent_x2",
            reason="Different people named Alex — different occupations, locations, handles",
        ),
        AntiLink(
            entity_a="ent_e1",
            entity_b="ent_a1",
            reason="Eve falsely claims to be Alice — adversarial",
        ),
        AntiLink(
            entity_a="ent_e1",
            entity_b="ent_a2",
            reason="Eve falsely claims to be Alice — adversarial",
        ),
    ],
)
