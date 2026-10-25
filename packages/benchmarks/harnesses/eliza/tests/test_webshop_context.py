"""The bridge preserves complete observations and prior action context."""

from types import SimpleNamespace as NS

import pytest
from eliza_adapter.webshop import ElizaBridgeWebShopAgent, _format_observation
from elizaos_webshop.types import PageObservation, PageType, Product, SearchResult, WebShopTask


def test_observation_contains_every_supplied_result_feature_and_action():
    results = [SearchResult(str(i), f"product-{i}", i, 4, "category") for i in range(24)]
    actions = [f"click[option-{i}]" for i in range(35)]
    rendered = _format_observation(PageObservation(PageType.RESULTS, "results", results=results, available_actions=actions))
    assert all(f"product-{i}" in rendered for i in range(24))
    assert all(action in rendered for action in actions)
    features = [f"feature-{i}" for i in range(30)]
    product = Product("id", "product", 10, "category", 4, features=features)
    rendered = _format_observation(PageObservation(PageType.PRODUCT, "product", product=product))
    assert all(feature in rendered for feature in features)


@pytest.mark.asyncio
async def test_every_prior_action_reaches_later_turns():
    prompts = []
    commands = [f"search[query-{i}]" for i in range(8)]
    observation = PageObservation(PageType.SEARCH, "search")

    class Client:
        def reset(self, **kwargs):
            pass

        def send_message(self, *, text, context):
            command = commands[len(prompts)]
            prompts.append(text)
            return NS(text=command, actions=["WEBSHOP_ACTION"], params={"command": command})

    class Environment:
        def reset(self, task):
            return observation

        def step(self, command):
            return NS(observation=observation, reward=0, done=False, info={})

    agent = ElizaBridgeWebShopAgent(Environment(), client=Client(), max_turns=len(commands))
    agent._initialized = True
    steps, _, _ = await agent.process_task(WebShopTask("history", "Find a product", []))
    assert [step.action for step in steps] == commands
    assert all(command in prompts[-1] for command in commands[:-1])
