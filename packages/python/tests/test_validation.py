import time

from elizaos.types.memory import Memory
from elizaos.types.primitives import Content
from elizaos.utils.validation import validate_action_keywords, validate_action_regex


def create_mock_memory(text: str, id: str = "1") -> Memory:
    return Memory(
        id=id,
        entity_id="user1",
        room_id="room1",
        agent_id="agent1",
        content=Content(text=text),
        created_at=int(time.time() * 1000),
    )


def test_validate_action_keywords():
    mock_message = Memory(
        id="123",
        entity_id="user1",
        room_id="room1",
        agent_id="agent1",
        content=Content(text="Hello world"),
        created_at=int(time.time() * 1000),
    )

    mock_recent_messages = [
        Memory(
            id="1",
            entity_id="user1",
            room_id="room1",
            agent_id="agent1",
            content=Content(text="Previous message 1"),
            created_at=0,
        ),
        Memory(
            id="2",
            entity_id="user1",
            room_id="room1",
            agent_id="agent1",
            content=Content(text="Previous message 2"),
            created_at=0,
        ),
        Memory(
            id="3",
            entity_id="user1",
            room_id="room1",
            agent_id="agent1",
            content=Content(text="Crypto is cool"),
            created_at=0,
        ),
        Memory(
            id="4",
            entity_id="user1",
            room_id="room1",
            agent_id="agent1",
            content=Content(text="Another message"),
            created_at=0,
        ),
        Memory(
            id="5",
            entity_id="user1",
            room_id="room1",
            agent_id="agent1",
            content=Content(text="Last one"),
            created_at=0,
        ),
    ]

    # 1. Keyword in current message
    msg = create_mock_memory("I want to transfer sol", "124")
    assert validate_action_keywords(msg, [], ["transfer"])

    # 2. Keyword in recent messages
    assert validate_action_keywords(mock_message, mock_recent_messages, ["crypto"])

    # 3. Keyword not found
    assert not validate_action_keywords(mock_message, mock_recent_messages, ["banana"])

    # 4. Case insensitive
    msg_upper = create_mock_memory("I want to TRANSFER sol", "125")
    assert validate_action_keywords(msg_upper, [], ["transfer"])

    # 5. Empty keywords list
    assert not validate_action_keywords(mock_message, mock_recent_messages, [])

    # 6. Partial match
    msg_partial = Memory(
        id="126",
        entity_id="user1",
        room_id="room1",
        agent_id="agent1",
        content=Content(text="cryptography"),
        created_at=0,
    )
    assert validate_action_keywords(msg_partial, [], ["crypto"])


def test_validate_action_regex():
    mock_message = create_mock_memory("Hello world", "123")
    mock_recent_messages = [
        create_mock_memory("Previous message 1", "1"),
        create_mock_memory("Previous message 2", "2"),
        create_mock_memory("Crypto is cool", "3"),
        create_mock_memory("Another message", "4"),
        create_mock_memory("Last one", "5"),
    ]

    # Regex in current message
    msg = create_mock_memory("Transfer 100 SOL")
    # Default re.search is case-sensitive
    assert not validate_action_regex(msg, [], r"transfer \d+ sol")
    # Use inline flag for case-insensitive
    assert validate_action_regex(msg, [], r"(?i)transfer \d+ sol")

    # Regex in recent messages
    assert validate_action_regex(mock_message, mock_recent_messages, r"(?i)crypto")

    # No match
    assert not validate_action_regex(mock_message, mock_recent_messages, r"banana")

    # Complex regex
    msg = create_mock_memory("user@example.com")
    assert validate_action_regex(msg, [], r"^[\w\.-]+@([\w-]+\.)+[\w-]{2,4}$")  # Empty pattern
    assert not validate_action_regex(mock_message, mock_recent_messages, "")

    # Unicode characters
    msg = create_mock_memory("Transfer 100 €")
    assert not validate_action_regex(msg, [], r"transfer \d+ €")  # case sensitive
    assert validate_action_regex(msg, [], r"(?i)transfer \d+ €")

    # Special characters
    msg = create_mock_memory("Hello (world) [ok]")
    assert validate_action_regex(msg, [], r"\(world\)")

    # Long inputs (basic DoS check)
    long_text = "a" * 10000 + "transfer"
    msg = create_mock_memory(long_text)
    assert validate_action_regex(msg, [], r"transfer")
