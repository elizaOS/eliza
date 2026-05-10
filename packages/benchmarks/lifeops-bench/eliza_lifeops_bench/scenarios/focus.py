"""Focus-domain scenarios.

Focus flows compose ``BLOCK_BLOCK`` (block native apps or websites via
phone-Family-Controls / hosts-file / SelfControl), ``SCREEN_TIME``
(read-only telemetry), and ``SCHEDULED_TASK`` (timed wraps). Wave 4A
collapsed the legacy ``APP_BLOCK`` and ``WEBSITE_BLOCK`` action names
into the unified ``BLOCK_*`` family — the same handler honors both
``packageNames`` (app blocks) and ``hostnames`` (website blocks)
through one parameter schema.

All Focus actions are paired with explicit duration windows and
``confirmed`` flags where the manifest requires them.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_TARA_NIGHT,
)

FOCUS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="focus.block_distracting_apps_25min",
        name="Block distracting apps for 25 minutes",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "block twitter and instagram for 25 minutes — i need to focus on "
            "thesis edits"
        ),
        ground_truth_actions=[
            Action(
                name="BLOCK_BLOCK",
                kwargs={
                    "subaction": "block",
                    "intent": "block twitter and instagram for 25 minutes",
                    "packageNames": [
                        "com.twitter.android",
                        "com.instagram.android",
                    ],
                    "durationMinutes": 25,
                },
            ),
        ],
        required_outputs=["block", "25"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just twitter and instagram for now.",
            applies_when="agent asks which apps",
        ),
        world_seed=2026,
        max_turns=5,
        description="Pomodoro-style block via BLOCK_BLOCK with packageNames.",
    ),
    Scenario(
        id="focus.block_distracting_websites_2hr",
        name="Block distracting websites for 2 hours",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction=(
            "Block hackernews and reddit for 2 hours so I can ship the "
            "client deck."
        ),
        ground_truth_actions=[
            Action(
                name="BLOCK_BLOCK",
                kwargs={
                    "subaction": "block",
                    "intent": "block hackernews and reddit for 120 minutes",
                    "hostnames": ["news.ycombinator.com", "reddit.com"],
                    "durationMinutes": 120,
                    "confirmed": True,
                },
            ),
        ],
        required_outputs=["block"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, confirmed — go ahead and block.",
            applies_when="agent asks for confirmation before blocking",
        ),
        world_seed=2026,
        max_turns=5,
        description="BLOCK_BLOCK with hostnames; requires explicit confirmed=True.",
    ),
    Scenario(
        id="focus.list_active_blocks",
        name="List active focus blocks",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="what blocks are active right now?",
        ground_truth_actions=[
            Action(
                name="BLOCK_LIST_ACTIVE",
                kwargs={
                    "subaction": "list_active",
                    "includeLiveStatus": True,
                    "includeManagedRules": True,
                },
            ),
        ],
        required_outputs=["active"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only state probe.",
    ),
    Scenario(
        id="focus.schedule_morning_focus_block_tomorrow",
        name="Schedule a focus block tomorrow 9-11am",
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Schedule a 2-hour focus block tomorrow morning from 9 to 11am "
            "UTC on my work calendar."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "create 2-hour focus block on cal_work 2026-05-11 09:00-11:00 UTC",
                    "title": "Focus block — deep work",
                    "details": {
                        "calendarId": "cal_work",
                        "start": "2026-05-11T09:00:00Z",
                        "end": "2026-05-11T11:00:00Z",
                    },
                },
            ),
        ],
        required_outputs=["focus"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Calendar-backed focus block (no screen-blocking action).",
    ),    Scenario(
        id='focus.block_social_media_30min',
        name='Block social media apps for 30 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='block facebook and snapchat for 30 minutes while I code.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block facebook and snapchat for 30 minutes',
                    'packageNames': [
                        'com.facebook.katana',
                        'com.snapchat.android',
                    ],
                    'durationMinutes': 30,
                },
            ),
        ],
        required_outputs=['facebook', '30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Simple block of two social apps using BLOCK_BLOCK.',
    ),
    Scenario(
        id='focus.block_news_sites_90min',
        name='Block news websites for 90 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Please block cnn.com and bbc.com for an hour and a half so I can finish the UI prototype.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block news websites for 90 minutes',
                    'hostnames': [
                        'cnn.com',
                        'bbc.com',
                    ],
                    'durationMinutes': 90,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['90'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, confirmed — go ahead and block.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=5,
        description='Blocks two news sites with explicit confirmation.',
    ),
    Scenario(
        id='focus.unblock_game_app',
        name='Unblock a game app',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='I need to let my kid play Candy Crush again, please unblock it.',
        ground_truth_actions=[
            Action(
                name='BLOCK_UNBLOCK',
                kwargs={
                    'subaction': 'unblock',
                    'intent': 'unblock Candy Crush app',
                    'packageNames': [
                        'com.king.candycrushsaga',
                    ],
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['Candy'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Demonstrates unblock action with confirmation.',
    ),
    Scenario(
        id='focus.block_streaming_45min',
        name='Block streaming services for 45 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Please block Netflix and YouTube for 45 minutes while I prepare the client deck.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block streaming services for 45 minutes',
                    'hostnames': [
                        'netflix.com',
                        'youtube.com',
                    ],
                    'durationMinutes': 45,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['Netflix', '45'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, go ahead and block.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=5,
        description='Blocks two streaming domains with required confirmation.',
    ),
    Scenario(
        id='focus.block_gaming_2hr',
        name='Block gaming apps for 2 hours',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='block steam and epic games for 2 hours so I can study.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block gaming apps for 120 minutes',
                    'packageNames': [
                        'com.valvesoftware.steam',
                        'com.epicgames.launcher',
                    ],
                    'durationMinutes': 120,
                },
            ),
        ],
        required_outputs=['2', 'gaming'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Long duration block of gaming platforms.',
    ),
    Scenario(
        id='focus.release_block_twitter',
        name='Release a previously set block on Twitter',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Please release the block on twitter that was set earlier today.',
        ground_truth_actions=[
            Action(
                name='BLOCK_RELEASE',
                kwargs={
                    'subaction': 'release',
                    'intent': 'release twitter block',
                    'hostnames': [
                        'twitter.com',
                    ],
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['twitter'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Confirmed, releasing the block now.',
            applies_when='agent asks for confirmation before releasing',
        ),
        world_seed=2026,
        max_turns=5,
        description='Shows releasing a specific host block.',
    ),
    Scenario(
        id='focus.block_productivity_sites_15min',
        name='Block productivity sites for 15 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='I keep getting distracted by Trello and Asana. Block them for 15 minutes.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block Trello and Asana for 15 minutes',
                    'hostnames': [
                        'trello.com',
                        'asana.com',
                    ],
                    'durationMinutes': 15,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['15'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Sure, blocking them now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=5,
        description='Short block of two project management sites.',
    ),
    Scenario(
        id='focus.request_permission_block',
        name='Request permission to block a site',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Can you ask for permission to block reddit for an hour?',
        ground_truth_actions=[
            Action(
                name='BLOCK_REQUEST_PERMISSION',
                kwargs={
                    'subaction': 'request_permission',
                    'intent': 'request permission to block reddit',
                    'hostnames': [
                        'reddit.com',
                    ],
                    'durationMinutes': 60,
                },
            ),
        ],
        required_outputs=['reddit'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Shows the permission request flow before blocking.',
    ),
    Scenario(
        id='focus.block_newsletter_60min',
        name='Block newsletter emails for 60 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='block incoming newsletters for an hour.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block newsletters for 60 minutes',
                    'hostnames': [
                        'mail.example.test',
                    ],
                    'durationMinutes': 60,
                },
            ),
        ],
        required_outputs=['hour'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Generic block of email host used for newsletters.',
    ),
    Scenario(
        id='focus.block_social_media_10min',
        name='Block social media for 10 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Just block instagram for 10 minutes while I finish my assignment.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block instagram for 10 minutes',
                    'packageNames': [
                        'com.instagram.android',
                    ],
                    'durationMinutes': 10,
                },
            ),
        ],
        required_outputs=['10'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Very short block targeting a single app.',
    ),
    Scenario(
        id='focus.block_video_sites_3hr',
        name='Block video streaming sites for 3 hours',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Please block Hulu and Disney+ for three hours while I do the kids' homework.",
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block video sites for 180 minutes',
                    'hostnames': [
                        'hulu.com',
                        'disneyplus.com',
                    ],
                    'durationMinutes': 180,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['180'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, confirmed — blocking now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Long block of two video services.',
    ),
    Scenario(
        id='focus.unblock_social_media',
        name='Unblock all social media sites',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Remove any blocks on social media platforms.',
        ground_truth_actions=[
            Action(
                name='BLOCK_UNBLOCK',
                kwargs={
                    'subaction': 'unblock',
                    'intent': 'unblock all social media',
                    'hostnames': [
                        'facebook.com',
                        'twitter.com',
                        'instagram.com',
                        'reddit.com',
                    ],
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['social'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Bulk unblock of typical social domains.',
    ),
    Scenario(
        id='focus.block_gaming_30min',
        name='Block gaming for 30 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Block all gaming apps for half an hour while I review the PR.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block gaming apps for 30 minutes',
                    'packageNames': [
                        'com.activision.callofduty',
                        'com.ea.game',
                    ],
                    'durationMinutes': 30,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['30'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Confirmed, blocking now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=5,
        description='Blocks two generic gaming packages.',
    ),
    Scenario(
        id='focus.block_news_20min',
        name='Block news sites for 20 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='I need to stay focused; block news.com and worldnews.com for 20 minutes.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block news sites for 20 minutes',
                    'hostnames': [
                        'news.com',
                        'worldnews.com',
                    ],
                    'durationMinutes': 20,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['20'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Short block of two generic news domains.',
    ),
    Scenario(
        id='focus.block_social_media_60min',
        name='Block social media for 60 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Please block all social media for an hour so I can finish my meditation practice.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block social media for 60 minutes',
                    'hostnames': [
                        'facebook.com',
                        'twitter.com',
                        'instagram.com',
                        'reddit.com',
                    ],
                    'durationMinutes': 60,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['hour'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, I’ll block them now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Broad block of major social platforms with clear confirmation.',
    ),
    Scenario(
        id='focus.block_work_tools_45min',
        name='Block work tools for 45 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Block slack and zoom for 45 minutes while I write the pitch.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block slack and zoom for 45 minutes',
                    'hostnames': [
                        'slack.com',
                        'zoom.us',
                    ],
                    'durationMinutes': 45,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['45'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Blocks two collaboration tools.',
    ),
    Scenario(
        id='focus.block_entertainment_120min',
        name='Block entertainment apps for 2 hours',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Please block Netflix, Hulu, and Spotify for two hours while I prepare the presentation.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block entertainment apps for 120 minutes',
                    'packageNames': [
                        'com.netflix.mediaclient',
                        'com.hulu.plus',
                        'com.spotify.music',
                    ],
                    'durationMinutes': 120,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['120'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Sure, I’ll block them now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Long block covering three major entertainment services.',
    ),
    Scenario(
        id='focus.block_news_and_social_30min',
        name='Block news and social for 30 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Block news.com and twitter.com for half an hour.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block news and twitter for 30 minutes',
                    'hostnames': [
                        'news.com',
                        'twitter.com',
                    ],
                    'durationMinutes': 30,
                },
            ),
        ],
        required_outputs=['30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Combined block of a news site and a social platform.',
    ),
    Scenario(
        id='focus.block_video_45min',
        name='Block video streaming for 45 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Block youtube.com and vimeo.com for 45 minutes while I code.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block video streaming for 45 minutes',
                    'hostnames': [
                        'youtube.com',
                        'vimeo.com',
                    ],
                    'durationMinutes': 45,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['45'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Blocks two video platforms.',
    ),
    Scenario(
        id='focus.block_social_and_gaming_90min',
        name='Block social and gaming for 90 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Block instagram, reddit, and steam for an hour and a half.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block social and gaming for 90 minutes',
                    'hostnames': [
                        'instagram.com',
                        'reddit.com',
                    ],
                    'packageNames': [
                        'com.valvesoftware.steam',
                    ],
                    'durationMinutes': 90,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['90'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Confirmed, proceeding with the block.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Mixed hostnames and packageNames block.',
    ),
    Scenario(
        id='focus.block_news_5min',
        name='Block news site for 5 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Just block news.com for five minutes while I meditate.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block news.com for 5 minutes',
                    'hostnames': [
                        'news.com',
                    ],
                    'durationMinutes': 5,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['5'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Very short block of a single news domain.',
    ),
    Scenario(
        id='focus.unblock_specific_app',
        name='Unblock a specific app',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Please unblock the YouTube app for my daughter.',
        ground_truth_actions=[
            Action(
                name='BLOCK_UNBLOCK',
                kwargs={
                    'subaction': 'unblock',
                    'intent': 'unblock YouTube app',
                    'packageNames': [
                        'com.google.android.youtube',
                    ],
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['YouTube'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Unblock a single app with confirmation.',
    ),
    Scenario(
        id='focus.block_entertainment_30min',
        name='Block entertainment for 30 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Block Netflix for 30 minutes.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block Netflix for 30 minutes',
                    'packageNames': [
                        'com.netflix.mediaclient',
                    ],
                    'durationMinutes': 30,
                },
            ),
        ],
        required_outputs=['30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Single-app block.',
    ),
    Scenario(
        id='focus.block_social_media_45min',
        name='Block social media for 45 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Block all social media sites for 45 minutes while I review the quarterly report.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block social media for 45 minutes',
                    'hostnames': [
                        'facebook.com',
                        'twitter.com',
                        'instagram.com',
                        'reddit.com',
                    ],
                    'durationMinutes': 45,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['45'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Confirmed, proceeding with the block.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Broad social block with explicit confirmation.',
    ),
    Scenario(
        id='focus.block_work_related_20min',
        name='Block work-related sites for 20 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Block jira.example.test and confluence.example.test for 20 minutes while I write the report.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block work sites for 20 minutes',
                    'hostnames': [
                        'jira.example.test',
                        'confluence.example.test',
                    ],
                    'durationMinutes': 20,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['20'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Blocks two internal work domains.',
    ),
    Scenario(
        id='focus.block_social_media_120min',
        name='Block social media for 2 hours',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Please block all social media for two hours so I can finish the budget spreadsheet.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block social media for 120 minutes',
                    'hostnames': [
                        'facebook.com',
                        'twitter.com',
                        'instagram.com',
                        'reddit.com',
                    ],
                    'durationMinutes': 120,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['2'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Sure, I’ll block them now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Extended social media block.',
    ),
    Scenario(
        id='focus.unblock_all',
        name='Unblock everything',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Remove all blocks I have set today.',
        ground_truth_actions=[
            Action(
                name='BLOCK_UNBLOCK',
                kwargs={
                    'subaction': 'unblock',
                    'intent': 'unblock all current blocks',
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['all'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Global unblock action.',
    ),
    Scenario(
        id='focus.block_educational_sites_15min',
        name='Block educational sites for 15 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Block khanacademy.org and coursera.org for 15 minutes while I help my child with homework.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block educational sites for 15 minutes',
                    'hostnames': [
                        'khanacademy.org',
                        'coursera.org',
                    ],
                    'durationMinutes': 15,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['15'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Blocks two learning platforms.',
    ),
    Scenario(
        id='focus.block_social_media_5min',
        name='Block social media for 5 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Block twitter.com for 5 minutes.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block twitter.com for 5 minutes',
                    'hostnames': [
                        'twitter.com',
                    ],
                    'durationMinutes': 5,
                },
            ),
        ],
        required_outputs=['5'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Minimal block of a single host.',
    ),
    Scenario(
        id='focus.block_video_and_social_60min',
        name='Block video and social for 60 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Block youtube.com and twitter.com for an hour.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block video and social for 60 minutes',
                    'hostnames': [
                        'youtube.com',
                        'twitter.com',
                    ],
                    'durationMinutes': 60,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['hour'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Confirmed, proceeding with the block.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=6,
        description='Combined block of a video site and a social site.',
    ),
    Scenario(
        id='focus.block_social_media_180min',
        name='Block social media for 3 hours',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Block all social media for three hours while I work on my personal project.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block social media for 180 minutes',
                    'hostnames': [
                        'facebook.com',
                        'twitter.com',
                        'instagram.com',
                        'reddit.com',
                    ],
                    'durationMinutes': 180,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['3'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Long-duration comprehensive social block.',
    ),
    Scenario(
        id='focus.block_productivity_tools_10min',
        name='Block productivity tools for 10 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Block Notion and ClickUp for 10 minutes while I focus on coding.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block productivity tools for 10 minutes',
                    'hostnames': [
                        'notion.so',
                        'clickup.com',
                    ],
                    'durationMinutes': 10,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['10'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Short block of two productivity web apps.',
    ),
    Scenario(
        id='focus.block_social_media_15min',
        name='Block social media for 15 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Please block instagram.com for 15 minutes.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block instagram.com for 15 minutes',
                    'hostnames': [
                        'instagram.com',
                    ],
                    'durationMinutes': 15,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['15'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Confirmed, blocking now.',
            applies_when='agent asks for confirmation before blocking',
        ),
        world_seed=2026,
        max_turns=5,
        description='Single-host short block with confirmation.',
    ),
    Scenario(
        id='focus.block_news_and_gaming_30min',
        name='Block news and gaming for 30 minutes',
        domain=Domain.FOCUS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Block news.com and steam for thirty minutes while I help my kid with schoolwork.',
        ground_truth_actions=[
            Action(
                name='BLOCK_BLOCK',
                kwargs={
                    'subaction': 'block',
                    'intent': 'block news and gaming for 30 minutes',
                    'hostnames': [
                        'news.com',
                    ],
                    'packageNames': [
                        'com.valvesoftware.steam',
                    ],
                    'durationMinutes': 30,
                    'confirmed': True,
                },
            ),
        ],
        required_outputs=['30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Mixed host and package block.',
    ),

]
