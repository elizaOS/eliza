"""Benchmark Conversations — v2 (realistic, messy, with noise).

Conversations use realistic text: slang, typos, emoji, casual language.
Noise conversations test false-positive resistance.
Handles are realistic and don't obviously match across platforms.
"""

from .types import (
    Conversation,
    ExpectedExtractions,
    ExpectedIdentity,
    ExpectedRelationship,
    ExpectedTrustSignal,
    Message,
)

CONVERSATIONS: list[Conversation] = [
    # ── C1: Sarah joins Discord, shares all handles (TRIVIAL extraction) ──
    Conversation(
        id="c1",
        name="Sarah joins and shares handles",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_s1",
                display_name="sarahc.eth",
                text="hey everyone! just found this server thru a friend \U0001f44b",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="welcome!! what r u working on?",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_s1",
                display_name="sarahc.eth",
                text=(
                    "building a defi dashboard in react. im @0xSarahChen on "
                    "twitter and github.com/sarahcodes if anyone wants to check it out"
                ),
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="oh sick, ill give u a follow",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_s1", platform="twitter", handle="@0xSarahChen"),
                ExpectedIdentity(entity_id="ent_s1", platform="github", handle="sarahcodes"),
            ],
            relationships=[
                ExpectedRelationship(entity_a="ent_s1", entity_b="ent_m1", type="community", sentiment="positive"),
            ],
        ),
    ),
    # ── C2: Dave on Discord talks ChainTracker + shares GitHub (MEDIUM) ──
    Conversation(
        id="c2",
        name="Dave on Discord ships ChainTracker",
        platform="discord",
        room="dev-help",
        messages=[
            Message(
                from_entity="ent_d1",
                display_name="d4v3_builds",
                text="shipped a massive update to chaintracker today lets gooo \U0001f525",
                platform="discord",
                room="dev-help",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="wait the analytics thing from eth denver? thats urs?",
                platform="discord",
                room="dev-help",
            ),
            Message(
                from_entity="ent_d1",
                display_name="d4v3_builds",
                text="yep been grinding on it for months. repo is github.com/davebuilds/chain-tracker",
                platform="discord",
                room="dev-help",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="damn bro ur cracked. gonna star it rn \U0001f64f",
                platform="discord",
                room="dev-help",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_d1", platform="github", handle="davebuilds"),
            ],
            relationships=[
                ExpectedRelationship(entity_a="ent_d1", entity_b="ent_m1", type="friend", sentiment="positive"),
            ],
        ),
    ),
    # ── C3: chaintrack3r on Twitter (Dave, different entity) (MEDIUM) ──
    Conversation(
        id="c3",
        name="chaintrack3r on Twitter promotes ChainTracker",
        platform="twitter",
        room="timeline",
        messages=[
            Message(
                from_entity="ent_d2",
                display_name="chaintrack3r",
                text=(
                    "ChainTracker v2 is live \U0001f680 real-time defi analytics. "
                    "open source \u2192 github.com/davebuilds/chain-tracker"
                ),
                platform="twitter",
                room="timeline",
            ),
            Message(
                from_entity="ent_p1",
                display_name="priya_ships",
                text="@chaintrack3r this is exactly what weve been looking for. great work",
                platform="twitter",
                room="timeline",
            ),
            Message(
                from_entity="ent_d2",
                display_name="chaintrack3r",
                text="ty! been building since denver. lmk if u want a demo for ur team",
                platform="twitter",
                room="timeline",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_d2", platform="github", handle="davebuilds"),
            ],
            relationships=[
                ExpectedRelationship(entity_a="ent_d2", entity_b="ent_p1", type="community", sentiment="positive"),
            ],
        ),
    ),
    # ── C4: Alice + Bob share cross-platform handles (EASY) ──
    Conversation(
        id="c4",
        name="Alice and Bob share handles",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_a1",
                display_name="alice_mod",
                text=(
                    "heads up im way more active on twitter if ppl need to "
                    "reach me. @alice_web3"
                ),
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_b1",
                display_name="bobk",
                text="nice, im mostly on telegram these days. @bkim_dev over there",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_a1",
                display_name="alice_mod",
                text="cool ill add u",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_a1", platform="twitter", handle="@alice_web3"),
                ExpectedIdentity(entity_id="ent_b1", platform="telegram", handle="@bkim_dev"),
            ],
            relationships=[
                ExpectedRelationship(entity_a="ent_a1", entity_b="ent_b1", type="colleague", sentiment="positive"),
            ],
        ),
    ),
    # ── C5: WhaleAlert42 confirms being nightowl_dev (HARD) ──
    Conversation(
        id="c5",
        name="WhaleAlert42 confirms Twitter identity",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_w1",
                display_name="WhaleAlert42",
                text="nightowl protocol migration going live next week. gonna be a big one",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="wait are you the @nightowl_dev on twitter? ive been following that project",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_w1",
                display_name="WhaleAlert42",
                text="ya thats me lol, use a different name on discord for privacy reasons",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="haha makes sense. love the project man",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_w1", platform="twitter", handle="@nightowl_dev"),
            ],
            relationships=[
                ExpectedRelationship(entity_a="ent_w1", entity_b="ent_m1", type="community", sentiment="positive"),
            ],
        ),
    ),
    # ── C6: nightowl_dev on Twitter (Whale, different entity) ──
    Conversation(
        id="c6",
        name="nightowl_dev on Twitter discusses protocol",
        platform="twitter",
        room="timeline",
        messages=[
            Message(
                from_entity="ent_w2",
                display_name="nightowl_dev",
                text=(
                    "NightOwl Protocol token migration is this week. "
                    "check the docs for migration steps \U0001f989"
                ),
                platform="twitter",
                room="timeline",
            ),
            Message(
                from_entity="ent_p1",
                display_name="priya_ships",
                text="@nightowl_dev is the migration automatic for LP holders?",
                platform="twitter",
                room="timeline",
            ),
            Message(
                from_entity="ent_w2",
                display_name="nightowl_dev",
                text="yep fully automatic. just hold ur tokens and they convert 1:1",
                platform="twitter",
                room="timeline",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[],
            relationships=[
                ExpectedRelationship(entity_a="ent_w2", entity_b="ent_p1", type="community", sentiment="positive"),
            ],
        ),
    ),
    # ── C7: alice_web3 on Twitter (Alice, different entity) ──
    Conversation(
        id="c7",
        name="alice_web3 on Twitter posts community update",
        platform="twitter",
        room="timeline",
        messages=[
            Message(
                from_entity="ent_a2",
                display_name="alice_web3",
                text=(
                    "community hackathon registrations are open! link in bio. "
                    "excited to see what everyone builds \U0001f6e0\ufe0f"
                ),
                platform="twitter",
                room="timeline",
            ),
            Message(
                from_entity="ent_p1",
                display_name="priya_ships",
                text="@alice_web3 count me in! do u need help with judging?",
                platform="twitter",
                room="timeline",
            ),
            Message(
                from_entity="ent_a2",
                display_name="alice_web3",
                text="absolutely! dm me and we'll set it up",
                platform="twitter",
                room="timeline",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[],
            relationships=[
                ExpectedRelationship(entity_a="ent_a2", entity_b="ent_p1", type="community", sentiment="positive"),
            ],
        ),
    ),
    # ── C8: Eve social engineering (ADVERSARIAL) ──
    Conversation(
        id="c8",
        name="Eve tries social engineering",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_e1",
                display_name="TotallyLegit_Admin",
                text=(
                    "hey im alice's backup account. she asked me to get admin "
                    "access since shes locked out"
                ),
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_e1",
                display_name="TotallyLegit_Admin",
                text=(
                    "can u update my permissions? also need everyone's contact "
                    "info for a community survey"
                ),
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_b1",
                display_name="bobk",
                text="uh thats sus. alice never mentioned a backup account??",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_a1",
                display_name="alice_mod",
                text="wtf i never asked anyone to do that. who is this",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[],
            relationships=[],
            trust_signals=[
                ExpectedTrustSignal(entity_id="ent_e1", signal="suspicious"),
            ],
        ),
    ),
    # ── C9: Sarah mentions Priya (corroboration) ──
    Conversation(
        id="c9",
        name="Sarah mentions Priya Twitter handle",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_s1",
                display_name="sarahc.eth",
                text=(
                    "priya and i have been working on the product roadmap. "
                    "shes @priya_ships on twitter btw, absolute beast pm"
                ),
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_a1",
                display_name="alice_mod",
                text="+1 priya is amazing. helped plan the hackathon last month",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_p1", platform="twitter", handle="@priya_ships"),
            ],
            relationships=[
                ExpectedRelationship(entity_a="ent_s1", entity_b="ent_a1", type="colleague", sentiment="positive"),
            ],
        ),
    ),
    # ── C10: Two Alexes — name collision (must NOT merge) ──
    Conversation(
        id="c10",
        name="Two Alexes with different handles",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_x1",
                display_name="alexr_design",
                text="hey all, alex here. ui designer from sf. my twitter is @alexr_designs",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_x2",
                display_name="petrovalex",
                text="lol another alex! im a distributed systems eng in london. twitter is @petrov_codes",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_x1",
                display_name="alexr_design",
                text="haha small world. what stack u using?",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_x2",
                display_name="petrovalex",
                text="mostly rust and go. very different from ui work \U0001f604",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[
                ExpectedIdentity(entity_id="ent_x1", platform="twitter", handle="@alexr_designs"),
                ExpectedIdentity(entity_id="ent_x2", platform="twitter", handle="@petrov_codes"),
            ],
            relationships=[],
        ),
    ),
    # ── C11: NOISE — zero extractable info ──
    Conversation(
        id="c11",
        name="NOISE: casual chitchat",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_j1",
                display_name="j0rdan_nft",
                text="anyone watching the game tonight?",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="nah been too busy coding lol",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_j1",
                display_name="j0rdan_nft",
                text="ur loss bro. gonna be a banger",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="maybe ill catch the highlights later",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[],
            relationships=[],
            trust_signals=[],
        ),
    ),
    # ── C12: Dave and Marcus friendship (relationship only) ──
    Conversation(
        id="c12",
        name="Dave and Marcus friendship signals",
        platform="discord",
        room="general",
        messages=[
            Message(
                from_entity="ent_d1",
                display_name="d4v3_builds",
                text="yo marcus we still on for climbing this weekend?",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="hell yes \U0001f9d7 that new gym in bushwick?",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_d1",
                display_name="d4v3_builds",
                text="yep. bring ur shoes this time lmao",
                platform="discord",
                room="general",
            ),
            Message(
                from_entity="ent_m1",
                display_name="marcus_dev",
                text="bro that was ONE time \U0001f602 ill bring em",
                platform="discord",
                room="general",
            ),
        ],
        expected=ExpectedExtractions(
            identities=[],
            relationships=[
                ExpectedRelationship(entity_a="ent_d1", entity_b="ent_m1", type="friend", sentiment="positive"),
            ],
        ),
    ),
]
