"""Messages-domain scenarios.

Covers iMessage, WhatsApp, Slack, Telegram, Signal, SMS, Discord
conversations seeded into ``data/snapshots/medium_seed_2026.json``.
The conversation ids referenced here (``conv_0007``, ``conv_0010``, etc.)
are real entries in that snapshot.

Channel routing flows through the ``MESSAGE`` umbrella action.
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

MESSAGES_SCENARIOS: list[Scenario] = [
    Scenario(
        id="messages.send_imessage_to_hannah",
        name="Send iMessage to Hannah Hill",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Send Hannah Hill an iMessage saying 'running 10 minutes late, "
            "see you at the cafe.'"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "imessage",
                    "targetKind": "contact",
                    "target": "Hannah Hill",
                    "message": "running 10 minutes late, see you at the cafe",
                },
            ),
        ],
        required_outputs=["sent", "Hannah"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "Single outbound iMessage to a real seeded contact "
            "(contact_00191 Hannah Hill)."
        ),
    ),
    Scenario(
        id="messages.summarize_unread_whatsapp_family_chat",
        name="Summarize unread WhatsApp family chat",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Catch me up on what I missed in the family WhatsApp group "
            "(conv_0005) since yesterday."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_channel",
                    "source": "whatsapp",
                    "roomId": "conv_0005",
                    "range": "dates",
                    "from": "2026-05-09T00:00:00Z",
                    "until": "2026-05-10T12:00:00Z",
                },
            ),
        ],
        required_outputs=["family"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just a short bullet list, no need to quote each message.",
            applies_when="agent asks about summary length or format",
        ),
        world_seed=2026,
        max_turns=6,
        description="Read-channel + summarize. Tests range=dates plumbing.",
    ),
    Scenario(
        id="messages.reply_in_climbing_buddies_telegram",
        name="Reply to climbing buddies group on Telegram",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "Tell the climbing buddies telegram group (conv_0003) i'm in for "
            "saturday but i can't do sunday"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "telegram",
                    "targetKind": "group",
                    "roomId": "conv_0003",
                    "message": "in for Saturday, can't do Sunday",
                },
            ),
        ],
        required_outputs=["Saturday"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Group send into a known telegram group conversation.",
    ),
    Scenario(
        id="messages.list_recent_signal_threads",
        name="List recent Signal threads",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="show me my last 5 signal conversations",
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "list_channels",
                    "source": "signal",
                    "limit": 5,
                },
            ),
        ],
        required_outputs=["signal"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Channel list — read-only, single source.",
    ),
    Scenario(
        id="messages.read_with_zane_on_slack",
        name="Read with Zane Turner on Signal",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Pull up my recent signal thread with Zane Turner so I can scan "
            "what we last discussed."
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "read_with_contact",
                    "source": "signal",
                    "contact": "Zane Turner",
                    "limit": 25,
                },
            ),
        ],
        required_outputs=["Zane"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="The last 25 messages or so is fine.",
            applies_when="agent asks how many messages to fetch",
        ),
        world_seed=2026,
        max_turns=5,
        description="Read-with-contact convenience routing.",
    ),
    Scenario(
        id="messages.send_quick_status_in_work_team_slack",
        name="Send status update in Work team Slack channel",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Post in the Work team slack group (conv_0006): 'shipping the "
            "checkout fix tonight, no review needed.'"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "slack",
                    "targetKind": "group",
                    "roomId": "conv_0006",
                    "message": "shipping the checkout fix tonight, no review needed",
                },
            ),
        ],
        required_outputs=["sent"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Group Slack send into a real conversation id.",
    ),    Scenario(
        id='messages.send_whatsapp_birthday_to_contact',
        name='Send WhatsApp birthday greeting',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Send a quick WhatsApp message to contact_00002 wishing them a happy birthday.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'whatsapp',
                    'targetKind': 'contact',
                    'target': 'contact_00002',
                    'message': 'Happy birthday! 🎉',
                },
            ),
        ],
        required_outputs=['birthday'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Simple outbound WhatsApp message to a seeded contact.',
    ),
    Scenario(
        id='messages.read_telegram_group_since_yesterday',
        name='Read Telegram group messages since yesterday',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Show me what was said in the family Telegram group (conv_0004) since yesterday.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'telegram',
                    'roomId': 'conv_0004',
                    'range': 'dates',
                    'from': '2026-05-09T00:00:00Z',
                    'until': '2026-05-10T12:00:00Z',
                },
            ),
        ],
        required_outputs=['family'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Read-channel with explicit date range for a Telegram group.',
    ),
    Scenario(
        id='messages.reply_slack_channel_task_update',
        name='Reply in Slack channel about task update',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Post in the project Slack channel (conv_0006) that I’ll finish the draft after lunch.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'slack',
                    'targetKind': 'group',
                    'roomId': 'conv_0006',
                    'message': 'I’ll finish the draft after lunch.',
                },
            ),
        ],
        required_outputs=['draft'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send to a Slack channel, verifying targetKind handling.',
    ),
    Scenario(
        id='messages.summarize_unread_signal_contact',
        name='Summarize unread Signal messages from a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Give me a summary of the unread messages from contact_00010 on Signal.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_with_contact',
                    'source': 'signal',
                    'contact': 'contact_00010',
                    'limit': 10,
                },
            ),
        ],
        required_outputs=['Signal'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Sure, I’ll pull the last 10 messages.',
            applies_when='agent asks how many messages to fetch',
        ),
        world_seed=2026,
        max_turns=5,
        description='Read-with-contact on Signal, testing limit parameter.',
    ),
    Scenario(
        id='messages.send_whatsapp_group_dinner',
        name='Send dinner invitation to WhatsApp group',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction="Message the weekend plans group (conv_0007) on WhatsApp: 'Dinner at 7pm? Let me know.'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'whatsapp',
                    'targetKind': 'group',
                    'roomId': 'conv_0007',
                    'message': 'Dinner at 7pm? Let me know.',
                },
            ),
        ],
        required_outputs=['Dinner'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send on WhatsApp, testing group target handling.',
    ),
    Scenario(
        id='messages.read_imessage_conversation_recent',
        name='Read recent iMessage conversation',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Show me the last 20 messages from the iMessage chat (conv_0008).',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'imessage',
                    'roomId': 'conv_0008',
                    'limit': 20,
                },
            ),
        ],
        required_outputs=['iMessage'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='20 messages works for me.',
            applies_when='agent asks how many messages to retrieve',
        ),
        world_seed=2026,
        max_turns=5,
        description='Read-channel on iMessage with limit parameter.',
    ),
    Scenario(
        id='messages.send_telegram_to_contact_with_emoji',
        name='Send Telegram message with emoji',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="Ping contact_00012 on Telegram saying 'On my way 🚗'.",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'telegram',
                    'targetKind': 'contact',
                    'target': 'contact_00012',
                    'message': 'On my way 🚗',
                },
            ),
        ],
        required_outputs=['🚗'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Outbound Telegram message with emoji to a seeded contact.',
    ),
    Scenario(
        id='messages.read_with_contact_imessage',
        name='Read recent iMessage with a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Show me the last 30 iMessage exchanges with contact_00015.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_with_contact',
                    'source': 'imessage',
                    'contact': 'contact_00015',
                    'limit': 30,
                },
            ),
        ],
        required_outputs=['iMessage'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='30 messages is fine.',
            applies_when='agent asks how many messages to fetch',
        ),
        world_seed=2026,
        max_turns=5,
        description='Read-with-contact on iMessage with a specific limit.',
    ),
    Scenario(
        id='messages.send_whatsapp_to_contact_confirm',
        name='Confirm before sending WhatsApp message',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction="Message contact_00020 on WhatsApp: 'Can you review the draft?'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'whatsapp',
                    'targetKind': 'contact',
                    'target': 'contact_00020',
                    'message': 'Can you review the draft?',
                },
            ),
        ],
        required_outputs=['draft'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Sure, I’ll send it now.',
            applies_when='agent asks for confirmation before sending',
        ),
        world_seed=2026,
        max_turns=6,
        description='Tests confirmation handling for a destructive (send) action.',
    ),
    Scenario(
        id='messages.read_telegram_group_today',
        name='Read today’s Telegram group chat',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='What did the kids’ Telegram group (conv_0009) discuss today?',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'telegram',
                    'roomId': 'conv_0009',
                    'range': 'dates',
                    'from': '2026-05-10T00:00:00Z',
                    'until': '2026-05-10T12:00:00Z',
                },
            ),
        ],
        required_outputs=['kids'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Date‑range read for a Telegram group, focusing on today.',
    ),
    Scenario(
        id='messages.send_imessage_to_contact',
        name='Send iMessage to a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction="Message contact_00025 on iMessage: 'Running a bit late, see you soon.'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'imessage',
                    'targetKind': 'contact',
                    'target': 'contact_00025',
                    'message': 'Running a bit late, see you soon.',
                },
            ),
        ],
        required_outputs=['late'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Outbound iMessage to a specific contact.',
    ),
    Scenario(
        id='messages.read_slack_thread_since_morning',
        name='Read Slack thread since morning',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Pull the messages from the #dev channel (conv_0010) since 8\u202fam today.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'slack',
                    'roomId': 'conv_0010',
                    'range': 'dates',
                    'from': '2026-05-10T08:00:00Z',
                    'until': '2026-05-10T12:00:00Z',
                },
            ),
        ],
        required_outputs=['#dev'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Slack channel read with explicit morning start time.',
    ),
    Scenario(
        id='messages.send_whatsapp_group_poll',
        name='Send poll to WhatsApp group',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Ask the project WhatsApp group (conv_0011) which date works for the demo: 'Mon or Tue?'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'whatsapp',
                    'targetKind': 'group',
                    'roomId': 'conv_0011',
                    'message': 'Which date works for the demo? Mon or Tue?',
                },
            ),
        ],
        required_outputs=['demo'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send on WhatsApp for a quick poll.',
    ),
    Scenario(
        id='messages.read_imessage_group_recent',
        name='Read recent iMessage group chat',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Show the last 15 messages from the family iMessage group (conv_0012).',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'imessage',
                    'roomId': 'conv_0012',
                    'limit': 15,
                },
            ),
        ],
        required_outputs=['family'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='15 messages will be enough.',
            applies_when='agent asks how many messages to fetch',
        ),
        world_seed=2026,
        max_turns=5,
        description='Read-channel on iMessage group with limit.',
    ),
    Scenario(
        id='messages.send_signal_to_contact',
        name='Send Signal message to a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction="Drop a quick Signal note to contact_00030: 'Yo, lunch tomorrow?'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'signal',
                    'targetKind': 'contact',
                    'target': 'contact_00030',
                    'message': 'Yo, lunch tomorrow?',
                },
            ),
        ],
        required_outputs=['lunch'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Simple Signal send to a seeded contact.',
    ),
    Scenario(
        id='messages.read_whatsapp_contact_recent',
        name='Read recent WhatsApp messages from a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Give me the latest 12 messages from contact_00035 on WhatsApp.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_with_contact',
                    'source': 'whatsapp',
                    'contact': 'contact_00035',
                    'limit': 12,
                },
            ),
        ],
        required_outputs=['WhatsApp'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Sure, I’ll pull the last 12 messages.',
            applies_when='agent asks how many messages to retrieve',
        ),
        world_seed=2026,
        max_turns=5,
        description='Read-with-contact on WhatsApp with explicit limit.',
    ),
    Scenario(
        id='messages.send_telegram_group_announcement',
        name='Send announcement to Telegram group',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Post in the soccer team Telegram group (conv_0013): 'Practice at 6pm tomorrow.'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'telegram',
                    'targetKind': 'group',
                    'roomId': 'conv_0013',
                    'message': 'Practice at 6pm tomorrow.',
                },
            ),
        ],
        required_outputs=['6pm'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send on Telegram for a scheduled event.',
    ),
    Scenario(
        id='messages.read_slack_direct_recent',
        name='Read recent Slack direct messages',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Show the last 8 direct messages I exchanged with contact_00040 on Slack.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_with_contact',
                    'source': 'slack',
                    'contact': 'contact_00040',
                    'limit': 8,
                },
            ),
        ],
        required_outputs=['Slack'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Read-with-contact on Slack with a small limit.',
    ),
    Scenario(
        id='messages.send_imessage_group_meeting',
        name='Send iMessage group meeting reminder',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Tell the project iMessage group (conv_0014) that the meeting starts at 3pm.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'imessage',
                    'targetKind': 'group',
                    'roomId': 'conv_0014',
                    'message': 'Meeting starts at 3pm.',
                },
            ),
        ],
        required_outputs=['3pm'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send on iMessage for a meeting reminder.',
    ),
    Scenario(
        id='messages.read_whatsapp_group_since_week_start',
        name='Read WhatsApp group since week start',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='What has the wellness WhatsApp group (conv_0015) talked about since Monday?',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'whatsapp',
                    'roomId': 'conv_0015',
                    'range': 'dates',
                    'from': '2026-05-04T00:00:00Z',
                    'until': '2026-05-10T12:00:00Z',
                },
            ),
        ],
        required_outputs=['wellness'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Date‑range read for a WhatsApp group spanning the week.',
    ),
    Scenario(
        id='messages.send_signal_group_brainstorm',
        name='Send Signal group brainstorm prompt',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Post in the brainstorming Signal group (conv_0016): 'Ideas for the Q3 launch?'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'signal',
                    'targetKind': 'group',
                    'roomId': 'conv_0016',
                    'message': 'Ideas for the Q3 launch?',
                },
            ),
        ],
        required_outputs=['Q3'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send on Signal to solicit ideas.',
    ),
    Scenario(
        id='messages.read_imessage_contact_since_yesterday',
        name='Read iMessage contact since yesterday',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Show me what contact_00045 sent me on iMessage since yesterday.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_with_contact',
                    'source': 'imessage',
                    'contact': 'contact_00045',
                    'range': 'dates',
                    'from': '2026-05-09T00:00:00Z',
                    'until': '2026-05-10T12:00:00Z',
                },
            ),
        ],
        required_outputs=['iMessage'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Read-with-contact on iMessage with date range.',
    ),
    Scenario(
        id='messages.read_signal_group_since_morning',
        name='Read Signal group messages since morning',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='What has the book club Signal group (conv_0017) discussed since 9am today?',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'signal',
                    'roomId': 'conv_0017',
                    'range': 'dates',
                    'from': '2026-05-10T09:00:00Z',
                    'until': '2026-05-10T12:00:00Z',
                },
            ),
        ],
        required_outputs=['book club'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Signal group read with morning start time.',
    ),
    Scenario(
        id='messages.send_imessage_group_followup',
        name='Send follow‑up to iMessage group',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="Follow up in the weekend plans iMessage group (conv_0018): 'Anyone up for hiking Saturday?'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'imessage',
                    'targetKind': 'group',
                    'roomId': 'conv_0018',
                    'message': 'Anyone up for hiking Saturday?',
                },
            ),
        ],
        required_outputs=['hiking'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Group send on iMessage for a weekend activity.',
    ),
    Scenario(
        id='messages.read_whatsapp_group_recent',
        name='Read recent WhatsApp group chat',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Show the last 25 messages from the meditation WhatsApp group (conv_0019).',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_channel',
                    'source': 'whatsapp',
                    'roomId': 'conv_0019',
                    'limit': 25,
                },
            ),
        ],
        required_outputs=['meditation'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='25 messages is fine.',
            applies_when='agent asks how many messages to fetch',
        ),
        world_seed=2026,
        max_turns=5,
        description='WhatsApp group read with limit.',
    ),
    Scenario(
        id='messages.send_telegram_contact_brief',
        name='Send brief Telegram message to a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Ping contact_00055 on Telegram: 'FYI, the report is ready.'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'telegram',
                    'targetKind': 'contact',
                    'target': 'contact_00055',
                    'message': 'FYI, the report is ready.',
                },
            ),
        ],
        required_outputs=['report'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Simple Telegram send to a seeded contact.',
    ),
    Scenario(
        id='messages.read_signal_contact_recent',
        name='Read recent Signal messages from a contact',
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Show me the latest 6 messages from contact_00060 on Signal.',
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'read_with_contact',
                    'source': 'signal',
                    'contact': 'contact_00060',
                    'limit': 6,
                },
            ),
        ],
        required_outputs=['Signal'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='6 messages works.',
            applies_when='agent asks how many messages to retrieve',
        ),
        world_seed=2026,
        max_turns=5,
        description='Read-with-contact on Signal with a small limit.',
    ),

]
