import asyncio
from uuid import uuid4
from elizaos import Character, AgentRuntime
# Avoid importing optional local plugins so the lightweight agent can run
# in environments where those packages are not installed.

async def main():
    character = Character(
        name="Eliza",
        username="eliza",
        bio="A helpful AI assistant.",
        system="You are helpful and concise.",
    )
    runtime = AgentRuntime(
        character=character,
        plugins=[],
    )
    user_id = uuid4()
    room_id = uuid4()
    await runtime.initialize()
    while True:
        user_input = input("You: ")
        response = await runtime.send_message(user_input, user_id, room_id)
        print("Eliza:", response.content.text)

if __name__ == "__main__":
    asyncio.run(main())
