"""Seeded fixture generators for LifeWorld.

Composable subgenerators (`generate_contacts`, `generate_emails`, etc.)
each take an instance of `WorldGenerator` and mutate the supplied world.
The top-level `generate_default_world()` ties them together at a chosen
scale.

All randomness goes through `self.rng = random.Random(seed)`. Never touch
the global `random` module — it is shared across the process and would
break determinism between tests run in the same interpreter.

All timestamps are anchored to `now_iso` (parsed at construction). The
generator never reads the wall clock.
"""

from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone
from typing import Literal

from .entities import (
    Calendar,
    CalendarEvent,
    ChatMessage,
    Contact,
    Conversation,
    EmailMessage,
    EmailThread,
    EntityKind,
    FinancialAccount,
    FinancialTransaction,
    HealthMetric,
    LocationPoint,
    Note,
    Reminder,
    ReminderList,
    Subscription,
)
from .world import LifeWorld

Scale = Literal["tiny", "small", "medium", "large", "huge"]


# Scale presets — (contacts, emails, chat_messages, conversations,
# calendar_events, reminders, notes, transactions, accounts,
# health_days, location_points). Picked so "small" exercises every kind
# without bloating tests, and "medium" approximates a real busy life.
SCALE_PRESETS: dict[Scale, dict[str, int]] = {
    "tiny": dict(
        contacts=10,
        emails=20,
        chat_messages=15,
        conversations=4,
        calendar_events=8,
        reminders=6,
        notes=5,
        transactions=10,
        accounts=2,
        health_days=7,
        location_points=20,
        subscriptions=2,
    ),
    "small": dict(
        contacts=30,
        emails=80,
        chat_messages=60,
        conversations=10,
        calendar_events=20,
        reminders=15,
        notes=15,
        transactions=40,
        accounts=3,
        health_days=14,
        location_points=80,
        subscriptions=4,
    ),
    "medium": dict(
        contacts=200,
        emails=2500,
        chat_messages=1200,
        conversations=40,
        calendar_events=120,
        reminders=60,
        notes=180,
        transactions=600,
        accounts=4,
        health_days=90,
        location_points=1200,
        subscriptions=8,
    ),
    "large": dict(
        contacts=400,
        emails=4000,
        chat_messages=1800,
        conversations=70,
        calendar_events=180,
        reminders=90,
        notes=260,
        transactions=900,
        accounts=5,
        health_days=120,
        location_points=2000,
        subscriptions=12,
    ),
    "huge": dict(
        contacts=500,
        emails=5000,
        chat_messages=2000,
        conversations=80,
        calendar_events=200,
        reminders=100,
        notes=300,
        transactions=1000,
        accounts=5,
        health_days=180,
        location_points=3000,
        subscriptions=15,
    ),
}


# Inline name + content tables. Small enough to keep deterministic across
# Python versions and avoid Faker as a dependency.
GIVEN_NAMES = [
    "Alice", "Bob", "Carol", "David", "Erin", "Frank", "Grace", "Henry",
    "Iris", "Jack", "Kira", "Liam", "Maya", "Noah", "Olivia", "Priya",
    "Quincy", "Rachel", "Sam", "Tara", "Uma", "Victor", "Wendy", "Xavier",
    "Yara", "Zane", "Aiden", "Beatrice", "Caleb", "Diana", "Ethan", "Fiona",
    "George", "Hannah", "Isaac", "Julia", "Kevin", "Luna", "Marco", "Nina",
    "Oscar", "Penelope", "Quinn", "Rosa", "Silas", "Talia", "Uriel", "Vera",
    "Walter", "Ximena",
]

FAMILY_NAMES = [
    "Nguyen", "Martinez", "Shah", "Alvarez", "Chen", "Patel", "Kim",
    "Garcia", "Smith", "Johnson", "Williams", "Brown", "Davis", "Miller",
    "Wilson", "Taylor", "Anderson", "Thomas", "Jackson", "White", "Harris",
    "Clark", "Lewis", "Walker", "Hall", "Young", "King", "Wright", "Lopez",
    "Hill", "Green", "Adams", "Baker", "Carter", "Mitchell", "Perez",
    "Roberts", "Turner", "Phillips", "Campbell",
]

COMPANIES = [
    "Acme Corp", "Globex", "Initech", "Hooli", "Pied Piper", "Dunder Mifflin",
    "Stark Industries", "Wayne Enterprises", "Cyberdyne", "Tyrell Corp",
    "Black Mesa", "Aperture Science", "Umbrella Corp", "Massive Dynamic",
    "Gringotts", "Vandelay Industries", "Vehement Capital", "Soylent",
    "Planet Express", "Rekall",
]

ROLES = [
    "Software Engineer", "Product Manager", "Designer", "Data Scientist",
    "Founder", "CEO", "Recruiter", "Marketing Lead", "Operations",
    "Investor", "Lawyer", "Accountant", "Teacher", "Doctor", "Nurse",
    "Therapist", "Coach", "Consultant", "Writer", "Editor",
]

EMAIL_SUBJECTS = [
    "Quick question about {topic}",
    "Re: {topic} update",
    "Following up on {topic}",
    "Meeting request: {topic}",
    "Action needed: {topic}",
    "FYI — {topic}",
    "Draft of {topic} attached",
    "Notes from {topic} sync",
    "Proposal: {topic}",
    "Reminder: {topic} due tomorrow",
    "Thanks for {topic}",
    "Welcome to {topic}",
    "Your {topic} receipt",
    "Newsletter: {topic}",
    "Important: {topic}",
]

EMAIL_TOPICS = [
    "Q3 planning", "the launch checklist", "the design review", "the contract",
    "next week's offsite", "the budget", "the partnership deck", "onboarding",
    "the customer escalation", "the security audit", "the migration plan",
    "the hiring loop", "the pitch", "the team retro", "the roadmap",
    "the analytics dashboard", "the demo script", "the press release",
    "the API docs", "vendor selection",
]

EMAIL_BODY_LINES = [
    "Hope you are doing well.",
    "Wanted to circle back on this.",
    "Let me know what you think when you get a chance.",
    "Adding a quick note since we discussed this earlier.",
    "Attaching the latest version for your review.",
    "Could you confirm by end of week?",
    "Happy to jump on a call if easier.",
    "No rush, but wanted this on your radar.",
    "Flagging because the deadline is approaching.",
    "Sharing in case it is useful.",
    "Thanks again for the help here.",
    "Looping in the team for visibility.",
    "Let me know if anything is unclear.",
    "Open to suggestions on next steps.",
    "Will follow up after the meeting tomorrow.",
]

MERCHANTS = [
    ("Whole Foods", "groceries"),
    ("Trader Joes", "groceries"),
    ("Amazon", "shopping"),
    ("Uber", "transit"),
    ("Lyft", "transit"),
    ("Starbucks", "coffee"),
    ("Blue Bottle", "coffee"),
    ("Shell", "fuel"),
    ("Chevron", "fuel"),
    ("Netflix", "entertainment"),
    ("Spotify", "entertainment"),
    ("Apple", "tech"),
    ("Costco", "groceries"),
    ("Target", "shopping"),
    ("CVS", "pharmacy"),
    ("Walgreens", "pharmacy"),
    ("Comcast", "utilities"),
    ("PG&E", "utilities"),
    ("AT&T", "utilities"),
    ("Delta", "travel"),
    ("United", "travel"),
    ("Marriott", "travel"),
    ("Airbnb", "travel"),
    ("Chipotle", "dining"),
    ("Sweetgreen", "dining"),
]

SUBSCRIPTION_NAMES = [
    ("Netflix", 1599),
    ("Spotify", 999),
    ("Apple iCloud", 299),
    ("New York Times", 1700),
    ("Disney+", 1399),
    ("YouTube Premium", 1399),
    ("Github Pro", 700),
    ("ChatGPT Plus", 2000),
    ("AWS", 5000),
    ("Notion", 1000),
    ("Figma", 1500),
    ("1Password", 500),
    ("Dropbox", 1200),
    ("Adobe Creative Cloud", 5499),
    ("Substack subscriptions", 1000),
]

LOCATIONS = [
    "Home", "Office", "Coffee shop", "Gym", "Conference room A",
    "Conference room B", "Google Meet", "Zoom", "Phone call",
    "Restaurant", "Park", "Airport",
]

NOTE_TITLES = [
    "Meeting notes", "Project ideas", "Reading list", "Recipe", "Workout plan",
    "Books to read", "Travel itinerary", "Birthday gift ideas",
    "Things to remember", "Weekly review", "Goals for the quarter",
    "Brainstorm session", "Lessons learned", "Open questions",
    "Follow-ups",
]

CONVERSATION_TITLES = [
    "Family chat", "Work team", "Project Atlas", "Lunch crew",
    "Book club", "Climbing buddies", "Weekend plans", "Side project",
    "College friends", "Neighborhood",
]

CHAT_MESSAGE_LINES = [
    "see you there",
    "running 5 late",
    "did you see this?",
    "yes",
    "no",
    "lol",
    "send me the link",
    "on my way",
    "can we move to 4pm?",
    "thanks!",
    "got it",
    "let me check and get back to you",
    "agreed",
    "sounds good",
    "rain check?",
    "happy birthday!",
    "did you eat?",
    "call me when free",
    "k",
    "sure",
]

CHAT_CHANNELS = ["imessage", "whatsapp", "signal", "telegram", "slack", "discord", "sms"]


class WorldGenerator:
    """Builds realistic LifeWorld fixtures from a seed.

    Anchor everything to `now_iso` so the same (seed, now_iso) pair always
    produces an identical world — including across machines and Python
    process restarts.
    """

    def __init__(
        self,
        *,
        seed: int,
        now_iso: str,
        scale: Scale = "medium",
        owner_email: str = "owner@example.test",
        owner_name: str = "Owner",
    ) -> None:
        self.seed = seed
        self.now_iso = now_iso
        self.scale: Scale = scale
        self.owner_email = owner_email
        self.owner_name = owner_name
        self.rng = random.Random(seed)
        self._now_dt = _parse_iso(now_iso)
        self.preset = SCALE_PRESETS[scale]

    # ----------------------------------------------------------- entry point

    def generate_default_world(self) -> LifeWorld:
        world = LifeWorld(seed=self.seed, now_iso=self.now_iso)
        # Order matters: contacts feed emails/chats; calendars feed events;
        # accounts feed transactions; reminder lists feed reminders.
        self.generate_contacts(world, self.preset["contacts"])
        self.generate_calendars(world)
        self.generate_calendar_events(world, self.preset["calendar_events"])
        self.generate_email_threads_and_messages(world, self.preset["emails"])
        self.generate_conversations_and_chat(
            world,
            n_conversations=self.preset["conversations"],
            n_messages=self.preset["chat_messages"],
        )
        self.generate_reminder_lists(world)
        self.generate_reminders(world, self.preset["reminders"])
        self.generate_notes(world, self.preset["notes"])
        self.generate_accounts(world, self.preset["accounts"])
        self.generate_transactions(world, self.preset["transactions"])
        self.generate_subscriptions(world, self.preset["subscriptions"])
        self.generate_health_metrics(world, self.preset["health_days"])
        self.generate_location_points(world, self.preset["location_points"])
        return world

    # --------------------------------------------------------------- contacts

    def generate_contacts(self, world: LifeWorld, n: int) -> list[Contact]:
        out: list[Contact] = []
        for i in range(n):
            given = self.rng.choice(GIVEN_NAMES)
            family = self.rng.choice(FAMILY_NAMES)
            company = self.rng.choice(COMPANIES) if self.rng.random() > 0.3 else None
            role = self.rng.choice(ROLES) if company else None
            relationship = self.rng.choices(
                ["family", "friend", "work", "acquaintance"],
                weights=[5, 20, 40, 35],
                k=1,
            )[0]
            n_phones = self.rng.choice([0, 1, 1, 2])
            phones = [self._phone() for _ in range(n_phones)]
            tags_pool = ["close", "team", "vendor", "investor", "school"]
            tags = sorted(self.rng.sample(tags_pool, k=self.rng.randint(0, 2)))
            contact = Contact(
                id=f"contact_{i:05d}",
                display_name=f"{given} {family}",
                given_name=given,
                family_name=family,
                primary_email=f"{given.lower()}.{family.lower()}{i}@example.test",
                phones=phones,
                company=company,
                role=role,
                relationship=relationship,
                importance=self.rng.randint(0, 10),
                tags=tags,
                birthday=self._birthday() if self.rng.random() > 0.6 else None,
            )
            world.add(EntityKind.CONTACT, contact)
            out.append(contact)
        return out

    def _phone(self) -> str:
        return f"+1555{self.rng.randint(1000000, 9999999):07d}"

    def _birthday(self) -> str:
        # Birthdays are date-only ISO strings (no time/zone).
        month = self.rng.randint(1, 12)
        day = self.rng.randint(1, 28)
        year = self.rng.randint(1955, 2005)
        return f"{year:04d}-{month:02d}-{day:02d}"

    # -------------------------------------------------------------- calendars

    def generate_calendars(self, world: LifeWorld) -> list[Calendar]:
        cals = [
            Calendar(
                id="cal_primary",
                name="Personal",
                color="#4285F4",
                owner=self.owner_email,
                source="google",
                is_primary=True,
            ),
            Calendar(
                id="cal_work",
                name="Work",
                color="#0F9D58",
                owner=self.owner_email,
                source="google",
                is_primary=False,
            ),
            Calendar(
                id="cal_family",
                name="Family",
                color="#DB4437",
                owner=self.owner_email,
                source="apple",
                is_primary=False,
            ),
        ]
        for c in cals:
            world.add(EntityKind.CALENDAR, c)
        return cals

    def generate_calendar_events(self, world: LifeWorld, n: int) -> list[CalendarEvent]:
        cals = list(world.calendars.values())
        contacts = list(world.contacts.values())
        out: list[CalendarEvent] = []
        for i in range(n):
            cal = self.rng.choice(cals)
            # Spread events ±90 days around now.
            day_offset = self.rng.randint(-90, 90)
            hour = self.rng.randint(7, 20)
            minute = self.rng.choice([0, 15, 30, 45])
            duration_min = self.rng.choice([15, 30, 30, 45, 60, 60, 90, 120])
            start_dt = self._now_dt + timedelta(
                days=day_offset, hours=hour, minutes=minute
            )
            # Anchor the start to local midnight + offset hours so all events
            # of the same day stack predictably (helps overlap detection).
            start_dt = start_dt.replace(
                hour=hour, minute=minute, second=0, microsecond=0
            )
            end_dt = start_dt + timedelta(minutes=duration_min)
            topic = self.rng.choice(EMAIL_TOPICS)
            attendees: list[str] = []
            if contacts and self.rng.random() > 0.3:
                k = self.rng.randint(1, min(4, len(contacts)))
                attendees = sorted(
                    {c.primary_email for c in self.rng.sample(contacts, k=k)}
                )
            status: Literal["confirmed", "tentative", "cancelled"] = self.rng.choices(
                ["confirmed", "tentative", "cancelled"],
                weights=[80, 15, 5],
                k=1,
            )[0]
            event = CalendarEvent(
                id=f"event_{i:05d}",
                calendar_id=cal.id,
                title=f"Sync: {topic}",
                description=self.rng.choice(EMAIL_BODY_LINES),
                location=self.rng.choice(LOCATIONS) if self.rng.random() > 0.3 else None,
                start=_iso(start_dt),
                end=_iso(end_dt),
                all_day=False,
                attendees=attendees,
                status=status,
                visibility="default",
                recurrence_rule=None,
                source=cal.source,
            )
            world.add(EntityKind.CALENDAR_EVENT, event)
            out.append(event)
        return out

    # -------------------------------------------------------------- emails

    def generate_email_threads_and_messages(
        self, world: LifeWorld, n_messages: int
    ) -> None:
        contacts = list(world.contacts.values())
        if not contacts:
            return
        # Roughly: 60% inbox, 25% archive, 10% sent, 3% drafts, 2% trash/spam.
        folder_weights = [
            ("inbox", 60),
            ("archive", 25),
            ("sent", 10),
            ("drafts", 3),
            ("trash", 1),
            ("spam", 1),
        ]
        # Group some messages into reply chains (threads): the first message
        # in a thread starts the conversation, subsequent share thread_id.
        thread_counter = 0
        # Track open threads so reply chains build naturally.
        open_threads: list[tuple[str, str, list[str], list[str]]] = []
        # tuples: (thread_id, subject, participants, message_ids_in_thread)
        for i in range(n_messages):
            folder = self.rng.choices(
                [f for f, _ in folder_weights],
                weights=[w for _, w in folder_weights],
                k=1,
            )[0]
            # 40% chance to reply into an existing thread (when one exists).
            if open_threads and self.rng.random() < 0.4:
                thread_id, subject, participants, msg_ids = open_threads[
                    self.rng.randint(0, len(open_threads) - 1)
                ]
                is_reply = True
            else:
                thread_counter += 1
                contact = self.rng.choice(contacts)
                topic = self.rng.choice(EMAIL_TOPICS)
                subject = self.rng.choice(EMAIL_SUBJECTS).format(topic=topic)
                thread_id = f"thread_{thread_counter:05d}"
                participants = sorted({contact.primary_email, self.owner_email})
                msg_ids = []
                is_reply = False
                open_threads.append((thread_id, subject, participants, msg_ids))

            # Pick sender / recipients based on folder.
            if folder in ("sent", "drafts"):
                from_email = self.owner_email
                # Recipients: the other thread participants.
                to_emails = sorted([p for p in participants if p != self.owner_email]) or [
                    self.rng.choice(contacts).primary_email
                ]
            else:
                from_email = self.rng.choice(
                    [p for p in participants if p != self.owner_email]
                    or [self.rng.choice(contacts).primary_email]
                )
                to_emails = [self.owner_email]

            sent_dt = self._now_dt - timedelta(
                days=self.rng.randint(0, 365),
                hours=self.rng.randint(0, 23),
                minutes=self.rng.randint(0, 59),
            )
            received_dt = sent_dt + timedelta(seconds=self.rng.randint(1, 60))
            n_lines = self.rng.randint(1, 5)
            body_lines = [self.rng.choice(EMAIL_BODY_LINES) for _ in range(n_lines)]
            body = "\n".join(body_lines)
            cc_emails: list[str] = []
            if self.rng.random() > 0.85 and len(contacts) > 1:
                cc_emails = sorted(
                    {self.rng.choice(contacts).primary_email for _ in range(2)}
                    - {from_email}
                )
            is_read = folder != "inbox" or self.rng.random() > 0.4
            is_starred = folder == "inbox" and self.rng.random() > 0.92
            labels: list[str] = []
            if folder == "inbox":
                labels = ["INBOX"]
                if not is_read:
                    labels.append("UNREAD")
                if is_starred:
                    labels.append("STARRED")

            display_subject = subject if not is_reply else f"Re: {subject}"
            msg_id = f"email_{i:06d}"
            msg = EmailMessage(
                id=msg_id,
                thread_id=thread_id,
                folder=folder,
                from_email=from_email,
                to_emails=to_emails,
                cc_emails=cc_emails,
                subject=display_subject,
                body_plain=body,
                sent_at=_iso(sent_dt),
                received_at=_iso(received_dt) if folder != "drafts" else None,
                is_read=is_read if folder not in ("drafts",) else True,
                is_starred=is_starred,
                labels=labels,
                attachments=[],
            )
            world.add(EntityKind.EMAIL, msg)
            msg_ids.append(msg_id)

            # Cap how many threads stay "open" so reply chains stay bounded.
            if len(open_threads) > 50:
                open_threads = open_threads[-50:]

        # Materialize threads.
        for thread_id, subject, participants, msg_ids in open_threads:
            if not msg_ids:
                continue
            last_msg = world.emails[msg_ids[-1]]
            world.add(
                EntityKind.EMAIL_THREAD,
                EmailThread(
                    id=thread_id,
                    subject=subject,
                    message_ids=list(msg_ids),
                    participants=list(participants),
                    last_activity_at=last_msg.sent_at,
                ),
            )

    # -------------------------------------------------------------- chat

    def generate_conversations_and_chat(
        self,
        world: LifeWorld,
        *,
        n_conversations: int,
        n_messages: int,
    ) -> None:
        contacts = list(world.contacts.values())
        if not contacts:
            return
        convs: list[Conversation] = []
        for i in range(n_conversations):
            channel = self.rng.choice(CHAT_CHANNELS)
            is_group = self.rng.random() > 0.6
            n_participants = (
                self.rng.randint(3, 6) if is_group else 2
            )
            picks = self.rng.sample(
                contacts, k=min(n_participants - 1, len(contacts))
            )
            participants = sorted({c.primary_email for c in picks} | {self.owner_email})
            title = (
                self.rng.choice(CONVERSATION_TITLES)
                if is_group
                else None
            )
            conv = Conversation(
                id=f"conv_{i:04d}",
                channel=channel,  # type: ignore[arg-type]
                participants=participants,
                title=title,
                last_activity_at=self.now_iso,
                is_group=is_group,
            )
            world.add(EntityKind.CONVERSATION, conv)
            convs.append(conv)
        if not convs:
            return
        for i in range(n_messages):
            conv = self.rng.choice(convs)
            from_handle = self.rng.choice(conv.participants)
            to_handles = [p for p in conv.participants if p != from_handle]
            sent_dt = self._now_dt - timedelta(
                days=self.rng.randint(0, 60),
                hours=self.rng.randint(0, 23),
                minutes=self.rng.randint(0, 59),
            )
            is_outgoing = from_handle == self.owner_email
            msg = ChatMessage(
                id=f"chat_{i:06d}",
                channel=conv.channel,
                conversation_id=conv.id,
                from_handle=from_handle,
                to_handles=to_handles,
                text=self.rng.choice(CHAT_MESSAGE_LINES),
                sent_at=_iso(sent_dt),
                is_read=is_outgoing or self.rng.random() > 0.2,
                is_outgoing=is_outgoing,
                attachments=[],
            )
            world.add(EntityKind.CHAT_MESSAGE, msg)

    # -------------------------------------------------------------- reminders

    def generate_reminder_lists(self, world: LifeWorld) -> list[ReminderList]:
        lists = [
            ReminderList(id="list_inbox", name="Inbox", source="apple-reminders"),
            ReminderList(id="list_work", name="Work", source="apple-reminders"),
            ReminderList(id="list_personal", name="Personal", source="apple-reminders"),
        ]
        for rl in lists:
            world.add(EntityKind.REMINDER_LIST, rl)
        return lists

    def generate_reminders(self, world: LifeWorld, n: int) -> list[Reminder]:
        lists = list(world.reminder_lists.values())
        if not lists:
            return []
        out: list[Reminder] = []
        for i in range(n):
            rl = self.rng.choice(lists)
            topic = self.rng.choice(EMAIL_TOPICS)
            day_offset = self.rng.randint(-7, 30)
            due_at = (
                _iso(self._now_dt + timedelta(days=day_offset, hours=9))
                if self.rng.random() > 0.2
                else None
            )
            priority = self.rng.choices(
                ["none", "low", "medium", "high"],
                weights=[40, 30, 20, 10],
                k=1,
            )[0]
            completed = (
                _iso(self._now_dt - timedelta(days=self.rng.randint(1, 30)))
                if self.rng.random() > 0.7
                else None
            )
            r = Reminder(
                id=f"reminder_{i:05d}",
                list_id=rl.id,
                title=f"Follow up on {topic}",
                notes=self.rng.choice(EMAIL_BODY_LINES),
                due_at=due_at,
                completed_at=completed,
                priority=priority,  # type: ignore[arg-type]
                tags=[],
            )
            world.add(EntityKind.REMINDER, r)
            out.append(r)
        return out

    # -------------------------------------------------------------- notes

    def generate_notes(self, world: LifeWorld, n: int) -> list[Note]:
        out: list[Note] = []
        for i in range(n):
            title = self.rng.choice(NOTE_TITLES)
            n_lines = self.rng.randint(2, 8)
            body = "\n".join(
                f"- {self.rng.choice(EMAIL_BODY_LINES)}" for _ in range(n_lines)
            )
            created_dt = self._now_dt - timedelta(days=self.rng.randint(1, 365))
            updated_dt = created_dt + timedelta(days=self.rng.randint(0, 30))
            note = Note(
                id=f"note_{i:05d}",
                title=f"{title} {i}",
                body_markdown=body,
                tags=[],
                created_at=_iso(created_dt),
                updated_at=_iso(updated_dt),
                source=self.rng.choice(["apple-notes", "obsidian", "notion"]),  # type: ignore[arg-type]
            )
            world.add(EntityKind.NOTE, note)
            out.append(note)
        return out

    # -------------------------------------------------------------- finance

    def generate_accounts(self, world: LifeWorld, n: int) -> list[FinancialAccount]:
        types: list[Literal["checking", "savings", "credit", "investment"]] = [
            "checking",
            "savings",
            "credit",
            "investment",
            "checking",
        ]
        institutions = ["Chase", "Schwab", "Amex", "Apple Card", "Wells Fargo"]
        out: list[FinancialAccount] = []
        for i in range(n):
            acct = FinancialAccount(
                id=f"account_{i:02d}",
                institution=institutions[i % len(institutions)],
                account_type=types[i % len(types)],
                balance_cents=self.rng.randint(50_000, 5_000_000),
                currency="USD",
                last4=f"{self.rng.randint(1000, 9999):04d}",
            )
            world.add(EntityKind.ACCOUNT, acct)
            out.append(acct)
        return out

    def generate_transactions(
        self, world: LifeWorld, n: int
    ) -> list[FinancialTransaction]:
        accounts = list(world.accounts.values())
        if not accounts:
            return []
        out: list[FinancialTransaction] = []
        for i in range(n):
            acct = self.rng.choice(accounts)
            merchant, category = self.rng.choice(MERCHANTS)
            amount_cents = -self.rng.randint(99, 25000)
            day_offset = self.rng.randint(-180, 0)
            posted_dt = self._now_dt + timedelta(
                days=day_offset, hours=self.rng.randint(0, 23)
            )
            txn = FinancialTransaction(
                id=f"txn_{i:06d}",
                account_id=acct.id,
                amount_cents=amount_cents,
                currency=acct.currency,
                merchant=merchant,
                category=category,
                description=f"{merchant} purchase",
                posted_at=_iso(posted_dt),
                is_pending=day_offset > -2 and self.rng.random() > 0.7,
            )
            world.add(EntityKind.TRANSACTION, txn)
            out.append(txn)
        return out

    def generate_subscriptions(self, world: LifeWorld, n: int) -> list[Subscription]:
        out: list[Subscription] = []
        for i in range(n):
            name, monthly_cents = SUBSCRIPTION_NAMES[i % len(SUBSCRIPTION_NAMES)]
            billing_day = self.rng.randint(1, 28)
            next_charge = self._now_dt + timedelta(days=self.rng.randint(1, 30))
            status = self.rng.choices(
                ["active", "paused", "cancelled"], weights=[85, 10, 5], k=1
            )[0]
            sub = Subscription(
                id=f"sub_{i:03d}",
                name=name,
                monthly_cents=monthly_cents,
                billing_day=billing_day,
                next_charge_at=_iso(next_charge),
                status=status,  # type: ignore[arg-type]
            )
            world.add(EntityKind.SUBSCRIPTION, sub)
            out.append(sub)
        return out

    # -------------------------------------------------------------- health

    def generate_health_metrics(self, world: LifeWorld, n_days: int) -> None:
        sources: list[Literal["apple-health", "fitbit", "oura", "manual"]] = [
            "apple-health",
            "fitbit",
            "oura",
        ]
        idx = 0
        for d in range(n_days):
            day_dt = self._now_dt - timedelta(days=d)
            # Steps once per day.
            world.add(
                EntityKind.HEALTH_METRIC,
                HealthMetric(
                    id=f"hm_{idx:06d}",
                    metric_type="steps",
                    value=float(self.rng.randint(2000, 18000)),
                    recorded_at=_iso(day_dt.replace(hour=23, minute=59, second=0)),
                    source=self.rng.choice(sources),
                ),
            )
            idx += 1
            world.add(
                EntityKind.HEALTH_METRIC,
                HealthMetric(
                    id=f"hm_{idx:06d}",
                    metric_type="sleep_hours",
                    value=round(self.rng.uniform(4.5, 9.5), 2),
                    recorded_at=_iso(day_dt.replace(hour=7, minute=0, second=0)),
                    source=self.rng.choice(sources),
                ),
            )
            idx += 1
            # Heart rate samples — 4 per day.
            for h in (8, 12, 16, 20):
                world.add(
                    EntityKind.HEALTH_METRIC,
                    HealthMetric(
                        id=f"hm_{idx:06d}",
                        metric_type="heart_rate",
                        value=float(self.rng.randint(55, 120)),
                        recorded_at=_iso(day_dt.replace(hour=h, minute=0, second=0)),
                        source=self.rng.choice(sources),
                    ),
                )
                idx += 1

    # ------------------------------------------------------------ location

    def generate_location_points(self, world: LifeWorld, n: int) -> None:
        # San Francisco-ish bounding box. Deterministic but varied.
        for i in range(n):
            lat = round(37.70 + self.rng.random() * 0.15, 6)
            lon = round(-122.50 + self.rng.random() * 0.20, 6)
            label = self.rng.choice(LOCATIONS) if self.rng.random() > 0.7 else None
            recorded = self._now_dt - timedelta(
                hours=self.rng.randint(0, 24 * 90),
                minutes=self.rng.randint(0, 59),
            )
            world.add(
                EntityKind.LOCATION_POINT,
                LocationPoint(
                    id=f"loc_{i:06d}",
                    latitude=lat,
                    longitude=lon,
                    label=label,
                    recorded_at=_iso(recorded),
                ),
            )


def _parse_iso(s: str) -> datetime:
    """Parse an ISO 8601 UTC timestamp into a tz-aware datetime.

    Accepts both `Z` suffix and `+00:00` offset.
    """
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _iso(dt: datetime) -> str:
    """Format a datetime as a stable ISO 8601 UTC string with `Z` suffix."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
