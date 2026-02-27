import asyncio
import uuid
from elizaos import Character, AgentRuntime


async def main():
    character = Character(
        name="TraderBot",
        username="traderbot",
        bio="Solana trader.",
        system="You are TraderBot. Keep responses focused on trading.",
    )
    agent_id = uuid.UUID("63adb390-3424-0d07-bf74-e7d049dfc2dc")
    runtime = AgentRuntime(character=character, agent_id=agent_id, plugins=[])
    await runtime.initialize()
    # Keep process alive to allow server to interact with this agent runtime
    print(f"TraderBot runtime started agentId={runtime.agent_id}")
    while True:
        await asyncio.sleep(60)


if __name__ == "__main__":
    asyncio.run(main())
